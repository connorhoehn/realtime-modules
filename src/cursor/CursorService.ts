// realtime-modules/src/cursor/CursorService.ts
//
// Lifted from gateway's src/realtime-fanout/cursor-service.ts (~586 LOC,
// Wave 2 catch-up extraction). Pure in-memory cursor fan-out with a
// periodic TTL sweep. No persistence, no DDB, no Redis.
//
// Lift changes vs the gateway original:
//   - Constructor switched from positional `(router, logger, metrics)` to a
//     single `CursorServiceOptions` bag so callers can wire optional
//     config (custom modes, authz hook, TTL/throttle/sweep tunables, …)
//     without an ever-growing signature.
//   - `enforceChannelPermission` interceptor coupling replaced with a
//     pluggable `authorizeChannel` hook (defaults to allow-all). Matches
//     chat / reactions / presence lift pattern.
//   - `ErrorCodes` / `createErrorResponse` import removed; the equivalent
//     error envelope is inlined locally (DEFAULT_ERROR_CODE in types).
//   - `ownership-cleanup-coordinator` registration removed entirely —
//     gateway-specific (room/Raft eviction) and lives on at the gateway
//     wiring layer. `cleanupRoom` is kept as a public method so the
//     gateway adapter can drive it.
//   - Periodic-sweep loop uses DC PeriodicSweep (overlap-protected, unref'd).
//   - `CURSOR_THROTTLE_INTERVAL_MS` / `CURSOR_TTL_MS` /
//     `CURSOR_CLEANUP_INTERVAL_MS` config-module imports replaced with
//     inline defaults (see types.ts), overridable via CursorConfig.
//
// Everything else (action dispatch, validation, throttle map, broadcast
// semantics, getStats, mode catalog) is byte-faithful to the original.

import { PeriodicSweep } from 'distributed-core';

import {
    DEFAULT_CLEANUP_INTERVAL_MS,
    DEFAULT_CURSOR_TTL_MS,
    DEFAULT_ERROR_CODE,
    DEFAULT_SUPPORTED_MODES,
    DEFAULT_THROTTLE_INTERVAL_MS,
    type CursorConfig,
    type CursorData,
    type CursorErrorFrame,
    type CursorLogger,
    type CursorMessageRouter,
    type CursorMetricsCollector,
    type CursorModeConfig,
    type CursorServiceOptions,
    type CursorUpdate,
} from './types';

export class CursorService {
    messageRouter: CursorMessageRouter;
    logger: CursorLogger;
    metricsCollector: CursorMetricsCollector | null;
    clientCursors: Map<string, CursorData>;
    channelCursors: Map<string, Map<string, CursorData>>;
    cursorUpdateThrottle: Map<string, number>;
    throttleInterval: number;
    cursorTTL: number;
    cleanupInterval: number;
    isDistributed: boolean;
    private readonly cleanupSweep: PeriodicSweep;
    supportedModes: Record<string, CursorModeConfig>;

    private authorizeChannel: (clientId: string, channel: string) => boolean;

    constructor(opts: CursorServiceOptions) {
        if (!opts || !opts.logger) {
            throw new Error('CursorService: logger is required');
        }
        if (!opts.messageRouter) {
            throw new Error('CursorService: messageRouter is required');
        }
        this.messageRouter = opts.messageRouter;
        this.logger = opts.logger;
        this.metricsCollector = opts.metricsCollector ?? null;

        const config: CursorConfig = opts.config ?? {};
        this.throttleInterval = config.throttleInterval ?? DEFAULT_THROTTLE_INTERVAL_MS;
        this.cursorTTL = config.cursorTTL ?? DEFAULT_CURSOR_TTL_MS;
        this.cleanupInterval = config.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL_MS;
        this.supportedModes = config.supportedModes
            ? { ...config.supportedModes }
            : { ...DEFAULT_SUPPORTED_MODES };
        this.authorizeChannel = config.authorizeChannel ?? (() => true);

        this.clientCursors = new Map();
        this.channelCursors = new Map();
        this.cursorUpdateThrottle = new Map();
        this.isDistributed = true;

        this.cleanupSweep = new PeriodicSweep({
            intervalMs: this.cleanupInterval,
            fn: () => this.cleanupStaleData(),
            onError: (err) => this.logger.error('Cursor cleanup sweep error', err),
        });
        this.cleanupSweep.start();
    }

    /**
     * Discard cursor positions and the active cursor map for a room.
     * Drops the channel's cursor map and matching per-client cursor entries
     * from clientCursors and from the throttle map for any clients whose
     * only known channel was this room. Cursors are ephemeral — no
     * persisted store to preserve.
     *
     * Gateway's ownership-cleanup-coordinator (room/Raft eviction) wires
     * this method as the `onLost` handler; here we expose it as a public
     * method so the adapter layer owns the coordinator coupling.
     */
    async cleanupRoom(roomId: string): Promise<void> {
        if (!roomId) return;

        const channelCursorMap = this.channelCursors.get(roomId);
        let cleared = 0;
        if (channelCursorMap) {
            cleared = channelCursorMap.size;
            for (const clientId of channelCursorMap.keys()) {
                const c = this.clientCursors.get(clientId);
                if (c && c.channel === roomId) {
                    this.clientCursors.delete(clientId);
                    this.cursorUpdateThrottle.delete(clientId);
                }
            }
            this.channelCursors.delete(roomId);
        }

        this.logger.info(
            `cursor-service flushed cursor state for roomId ${roomId} (${cleared} cursor(s) cleared)`,
        );
    }

    async handleAction(clientId: string, action: string, data: any): Promise<void> {
        const startTime = Date.now();
        try {
            switch (action) {
                case 'update':
                    await this.handleUpdateCursor(clientId, data);
                    return;
                case 'subscribe':
                    await this.handleSubscribeCursors(clientId, data);
                    return;
                case 'unsubscribe':
                    await this.handleUnsubscribeCursors(clientId, data);
                    return;
                case 'get':
                    await this.handleGetCursors(clientId, data);
                    return;
                case 'modes':
                    await this.handleGetModes(clientId, data);
                    return;
                default:
                    this.sendError(clientId, `Unknown cursor action: ${action}`);
            }
        } catch (error: any) {
            this.logger.error(`Error handling cursor action ${action} for client ${clientId}:`, error);
            this.sendError(clientId, 'Internal server error');
        } finally {
            const duration = Date.now() - startTime;
            this.logger.info(`[cursor] ${action}`, { clientId, channel: data?.channel, duration });
            if (duration > 500) {
                this.logger.warn(`Slow message handler: cursor/${action} took ${duration}ms`, { clientId });
            }
        }
    }

    async handleUpdateCursor(
        clientId: string,
        { channel, position, metadata = {}, mode = 'freeform' }: CursorUpdate,
    ): Promise<void> {
        if (!channel || !position) {
            this.sendError(clientId, 'Channel and position are required');
            return;
        }

        const effectiveMode = (metadata as any).mode || mode;

        if (!this.supportedModes[effectiveMode]) {
            this.sendError(
                clientId,
                `Unsupported cursor mode: ${effectiveMode}. Supported modes: ${Object.keys(this.supportedModes).join(', ')}`,
            );
            return;
        }

        if (!this.validatePositionForMode(position, effectiveMode)) {
            const modeConfig = this.supportedModes[effectiveMode];
            this.sendError(
                clientId,
                `Invalid position for mode ${effectiveMode}. Required fields: ${modeConfig.requiredFields.join(', ')}`,
            );
            return;
        }

        if (!this.shouldUpdateCursor(clientId)) {
            return;
        }

        const cursorData: CursorData = {
            clientId,
            channel,
            position,
            metadata: {
                ...(metadata as any),
                mode: effectiveMode,
                userInitials: (metadata as any).userInitials || this.generateInitials(clientId),
                userColor: (metadata as any).userColor || this.generateUserColor(clientId),
            },
            timestamp: new Date().toISOString(),
        };

        await this.storeCursorData(clientId, channel, cursorData);
        await this.broadcastCursorUpdate(channel, cursorData, clientId);

        this.logger.info(`Cursor updated for client ${clientId} in channel ${channel} (mode: ${effectiveMode})`);
    }

    async storeCursorData(clientId: string, channel: string, cursorData: CursorData): Promise<void> {
        this.storeLocalCursorData(clientId, channel, cursorData);
    }

    storeLocalCursorData(clientId: string, channel: string, cursorData: CursorData): void {
        this.clientCursors.set(clientId, cursorData);
        if (!this.channelCursors.has(channel)) {
            this.channelCursors.set(channel, new Map());
        }
        this.channelCursors.get(channel)!.set(clientId, cursorData);
    }

    validatePositionForMode(position: any, mode: string): boolean {
        const modeConfig = this.supportedModes[mode];
        if (!modeConfig) return false;

        for (const field of modeConfig.requiredFields) {
            if (position[field] === undefined || position[field] === null) {
                return false;
            }
        }

        switch (mode) {
            case 'freeform':
            case 'canvas':
                return typeof position.x === 'number' && typeof position.y === 'number';
            case 'table':
                return (
                    typeof position.row === 'number' &&
                    typeof position.col === 'number' &&
                    position.row >= 0 &&
                    position.col >= 0
                );
            case 'text':
                return typeof position.position === 'number' && position.position >= 0;
            default:
                return false;
        }
    }

    generateInitials(clientId: string): string {
        return clientId.substring(0, 2).toUpperCase();
    }

    generateUserColor(clientId: string): string {
        const colors = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FECA57',
            '#FF9FF3', '#54A0FF', '#5F27CD', '#00D2D3', '#FF9F43',
            '#1DD1A1', '#F368E0', '#3742FA', '#2F3542', '#FF3838',
        ];
        let hash = 0;
        for (let i = 0; i < clientId.length; i++) {
            hash = clientId.charCodeAt(i) + ((hash << 5) - hash);
        }
        return colors[Math.abs(hash) % colors.length];
    }

    async handleGetModes(clientId: string, _data: unknown): Promise<void> {
        this.sendToClient(clientId, {
            type: 'cursor',
            action: 'modes',
            modes: this.supportedModes,
            timestamp: new Date().toISOString(),
        });

        this.logger.debug(`Sent cursor modes to client ${clientId}`);
    }

    async handleSubscribeCursors(clientId: string, { channel }: { channel: string }): Promise<void> {
        if (!channel) {
            this.sendError(clientId, 'Channel is required');
            return;
        }

        try {
            if (!this.authorizeChannel(clientId, channel)) {
                this.sendError(clientId, `Not authorized for channel: ${channel}`);
                return;
            }

            await this.messageRouter.subscribeToChannel(clientId, `cursor:${channel}`);

            const channelCursors = await this.getChannelCursors(channel);
            this.sendToClient(clientId, {
                type: 'cursor',
                action: 'subscribed',
                channel,
                cursors: channelCursors,
                timestamp: new Date().toISOString(),
            });

            this.logger.info(`Client ${clientId} subscribed to cursors for channel: ${channel}`);
        } catch (error: any) {
            this.logger.error(`Error subscribing to cursors for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to subscribe to cursors');
        }
    }

    async handleUnsubscribeCursors(clientId: string, { channel }: { channel: string }): Promise<void> {
        if (!channel) {
            this.sendError(clientId, 'Channel is required');
            return;
        }

        await this.messageRouter.unsubscribeFromChannel(clientId, `cursor:${channel}`);

        this.sendToClient(clientId, {
            type: 'cursor',
            action: 'unsubscribed',
            channel,
            timestamp: new Date().toISOString(),
        });

        this.logger.info(`Client ${clientId} unsubscribed from cursors for channel: ${channel}`);
    }

    async handleGetCursors(clientId: string, { channel }: { channel: string }): Promise<void> {
        if (!channel) {
            this.sendError(clientId, 'Channel is required');
            return;
        }

        const channelCursors = await this.getChannelCursors(channel);
        this.sendToClient(clientId, {
            type: 'cursor',
            action: 'cursors',
            channel,
            cursors: channelCursors,
            timestamp: new Date().toISOString(),
        });

        this.logger.debug(`Sent cursor list for channel ${channel} to client ${clientId}`);
    }

    shouldUpdateCursor(clientId: string): boolean {
        const now = Date.now();
        const lastUpdate = this.cursorUpdateThrottle.get(clientId) || 0;

        if (now - lastUpdate < this.throttleInterval) {
            return false;
        }

        this.cursorUpdateThrottle.set(clientId, now);
        return true;
    }

    async getChannelCursors(channel: string): Promise<CursorData[]> {
        return this.getLocalChannelCursors(channel);
    }

    getLocalChannelCursors(channel: string): CursorData[] {
        const channelCursorMap = this.channelCursors.get(channel);
        if (!channelCursorMap) return [];
        return Array.from(channelCursorMap.values());
    }

    async broadcastCursorUpdate(channel: string, cursorData: CursorData, excludeClientId: string): Promise<void> {
        const message = {
            type: 'cursor',
            action: 'update',
            channel,
            cursor: cursorData,
            timestamp: new Date().toISOString(),
        };

        await this.messageRouter.sendToChannel(`cursor:${channel}`, message, excludeClientId);
    }

    sendToClient(clientId: string, message: unknown): void {
        this.messageRouter.sendToClient(clientId, message);
    }

    sendError(clientId: string, message: string, errorCode: string = DEFAULT_ERROR_CODE): void {
        const errorFrame: CursorErrorFrame = {
            type: 'error',
            service: 'cursor',
            error: {
                code: errorCode,
                message,
                timestamp: new Date().toISOString(),
                service: 'cursor',
                clientId,
            },
        };

        this.sendToClient(clientId, errorFrame);

        if (this.metricsCollector) {
            this.metricsCollector.recordError(errorCode);
        }
    }

    async onClientConnect(clientId: string): Promise<void> {
        this.logger.debug(`Client ${clientId} connected to cursor service`);
    }

    async onClientDisconnect(clientId: string): Promise<void> {
        await this.removeCursorData(clientId);
        this.cursorUpdateThrottle.delete(clientId);
        this.logger.debug(`Client ${clientId} disconnected from cursor service`);
    }

    async removeCursorData(clientId: string): Promise<void> {
        await this.removeLocalCursorData(clientId);
    }

    async removeLocalCursorData(clientId: string): Promise<void> {
        const clientCursor = this.clientCursors.get(clientId);
        if (clientCursor) {
            const { channel } = clientCursor;
            this.clientCursors.delete(clientId);

            const channelCursorMap = this.channelCursors.get(channel);
            if (channelCursorMap) {
                channelCursorMap.delete(clientId);
                if (channelCursorMap.size === 0) {
                    this.channelCursors.delete(channel);
                }
                await this.broadcastCursorRemoval(channel, clientId);
            }
        }
    }

    async broadcastCursorRemoval(channel: string, clientId: string): Promise<void> {
        const message = {
            type: 'cursor',
            action: 'remove',
            channel,
            clientId,
            timestamp: new Date().toISOString(),
        };

        await this.messageRouter.sendToChannel(`cursor:${channel}`, message);
    }

    async shutdown(): Promise<void> {
        await this.cleanupSweep.stop();

        this.clientCursors.clear();
        this.channelCursors.clear();
        this.cursorUpdateThrottle.clear();

        this.logger.info('Cursor service shut down');
    }

    cleanupStaleData(): void {
        const now = Date.now();
        const staleCursors: string[] = [];

        for (const [clientId, cursorData] of this.clientCursors) {
            const cursorAge = now - new Date(cursorData.timestamp).getTime();
            if (cursorAge > this.cursorTTL) {
                staleCursors.push(clientId);
            }
        }

        for (const clientId of staleCursors) {
            this.logger.debug(`Removing stale cursor data for client ${clientId}`);
            void this.removeStaleClientCursor(clientId);
        }

        if (staleCursors.length > 0) {
            this.logger.info(`Cleaned up ${staleCursors.length} stale cursor(s)`);
        }
    }

    async removeStaleClientCursor(clientId: string): Promise<void> {
        const clientCursor = this.clientCursors.get(clientId);
        if (clientCursor) {
            const { channel } = clientCursor;
            this.clientCursors.delete(clientId);

            const channelCursorMap = this.channelCursors.get(channel);
            if (channelCursorMap) {
                channelCursorMap.delete(clientId);
                if (channelCursorMap.size === 0) {
                    this.channelCursors.delete(channel);
                }
                await this.broadcastCursorRemoval(channel, clientId);
            }
        }

        this.cursorUpdateThrottle.delete(clientId);
    }

    getStats(): {
        connectedClients: number;
        activeChannels: number;
        isDistributed: boolean;
    } {
        return {
            connectedClients: this.clientCursors.size,
            activeChannels: this.channelCursors.size,
            isDistributed: this.isDistributed,
        };
    }
}

export default CursorService;
