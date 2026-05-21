// realtime-modules/src/presence/PresenceService.ts
//
// In-process presence tracking lifted from gateway's
// src/realtime-fanout/presence-service.ts (Wave 2).
//
// CONSERVATIVE LIFT — surface only, not persistence:
//
//   LIFTED (here):
//     - clientPresence / channelPresence / clientChannels maps
//     - handleAction dispatch (set, get, subscribe, unsubscribe, heartbeat)
//     - broadcastPresenceUpdate via MessageRouterContract
//     - stale-client cleanup + disconnect-delay timers
//     - getStats, shutdown, onClientConnect / onClientDisconnect
//
//   LEFT in gateway (NOT lifted — gateway-specific):
//     - presenceRegistry dual-write to DC's EntityRegistry
//       (gated by WSG_PRESENCE_REGISTRY_ENABLED / WSG_PRESENCE_REGISTRY_AUTHORITATIVE)
//       Including _shadowWritePresence, _shadowReleasePresence,
//       _readClientPresenceFromRegistry, _readChannelPresenceFromRegistry,
//       setPresenceRegistry, setAuthoritativeReads.
//     - Ownership-cleanup-coordinator integration (_flushRoomPresence,
//       registerOwnershipHandlers). Requires gateway's distributed coordinator;
//       deferred until consumers have an equivalent abstraction.
//     - sendError() with ErrorCodes/metricsCollector — replaced with a
//       simpler `{ type: 'error', message }` frame since consumers don't
//       all share gateway's error-codes module.
//     - recordPresenceShadow observability metric — only matters when
//       the registry shadow path is wired.
//
//   The result is byte-identical at the WS layer for consumers that
//   weren't using the registry shadow-write path.

import { EvictionTimer, PeriodicSweep } from 'distributed-core';
import type {
    PresenceConfig,
    PresenceEntry,
    PresenceLogger,
    PresenceMessageRouter,
    PresenceStatus,
    PresenceUpdate,
} from './types';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_PRESENCE_TIMEOUT_MS = 60_000;
const DEFAULT_STALE_THRESHOLD_MS = 90_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 30_000;
const DEFAULT_DISCONNECT_DELAY_MS = 5_000;
const DEFAULT_MAX_METADATA_KEYS = 20;
const DEFAULT_MAX_METADATA_SIZE = 4_096;

const VALID_STATUSES: readonly PresenceStatus[] = ['online', 'away', 'busy', 'offline'];

function readEnvInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function validateMetadata(
    metadata: unknown,
    maxKeys: number,
    maxSize: number,
    logger: PresenceLogger,
): Record<string, unknown> {
    if (!metadata || typeof metadata !== 'object') return {};

    let working: Record<string, unknown> = { ...(metadata as Record<string, unknown>) };

    const keys = Object.keys(working);
    if (keys.length > maxKeys) {
        logger.warn(`Metadata exceeds key limit: ${keys.length}/${maxKeys}`);
        const truncated: Record<string, unknown> = {};
        for (let i = 0; i < maxKeys; i++) {
            truncated[keys[i]] = working[keys[i]];
        }
        working = truncated;
    }

    const serialized = JSON.stringify(working);
    if (serialized.length > maxSize) {
        logger.warn(`Metadata exceeds size limit: ${serialized.length}/${maxSize}`);
        return {
            _truncated: true,
            displayName: (working as Record<string, unknown>).displayName || 'unknown',
        };
    }

    return working;
}

class PresenceService {
    private messageRouter: PresenceMessageRouter;
    private logger: PresenceLogger;
    private authorizeChannel: (clientId: string, channel: string) => boolean;

    // Tunables resolved from PresenceConfig overrides → env vars → defaults.
    private readonly heartbeatIntervalMs: number;
    private readonly presenceTimeoutMs: number;
    private readonly staleThresholdMs: number;
    private readonly cleanupIntervalMs: number;
    private readonly disconnectDelayMs: number;
    private readonly maxMetadataKeys: number;
    private readonly maxMetadataSize: number;

    // Public state — exposed for tests & consumer-app debugging dashboards,
    // matching gateway's original surface.
    clientPresence: Map<string, PresenceEntry>;
    channelPresence: Map<string, Map<string, PresenceEntry>>;
    clientChannels: Map<string, Set<string>>;
    readonly disconnectEviction: EvictionTimer;

    private readonly heartbeatSweep: PeriodicSweep;
    private readonly cleanupSweep: PeriodicSweep;

    constructor(
        messageRouter: PresenceMessageRouter,
        logger: PresenceLogger,
        config: PresenceConfig = {},
    ) {
        if (!messageRouter) {
            throw new Error('PresenceService: messageRouter is required');
        }

        this.messageRouter = messageRouter;
        this.logger = logger;
        this.authorizeChannel = config.authorizeChannel || (() => true);

        this.heartbeatIntervalMs = config.heartbeatIntervalMs
            ?? readEnvInt('PRESENCE_HEARTBEAT_INTERVAL_MS', DEFAULT_HEARTBEAT_INTERVAL_MS);
        this.presenceTimeoutMs = config.presenceTimeoutMs
            ?? readEnvInt('PRESENCE_TIMEOUT_MS', DEFAULT_PRESENCE_TIMEOUT_MS);
        this.staleThresholdMs = config.staleThresholdMs
            ?? readEnvInt('PRESENCE_STALE_THRESHOLD_MS', DEFAULT_STALE_THRESHOLD_MS);
        this.cleanupIntervalMs = config.cleanupIntervalMs
            ?? readEnvInt('PRESENCE_CLEANUP_INTERVAL_MS', DEFAULT_CLEANUP_INTERVAL_MS);
        this.disconnectDelayMs = config.disconnectDelayMs
            ?? readEnvInt('PRESENCE_DISCONNECT_DELAY_MS', DEFAULT_DISCONNECT_DELAY_MS);
        this.maxMetadataKeys = config.maxMetadataKeys
            ?? readEnvInt('PRESENCE_MAX_METADATA_KEYS', DEFAULT_MAX_METADATA_KEYS);
        this.maxMetadataSize = config.maxMetadataSize
            ?? readEnvInt('PRESENCE_MAX_METADATA_SIZE', DEFAULT_MAX_METADATA_SIZE);

        this.clientPresence = new Map();
        this.channelPresence = new Map();
        this.clientChannels = new Map();
        this.disconnectEviction = new EvictionTimer(this.disconnectDelayMs);

        this.heartbeatSweep = new PeriodicSweep({
            intervalMs: this.heartbeatIntervalMs,
            fn: () => this.cleanupStalePresence(),
            onError: (err) => this.logger.error('Presence heartbeat error', err),
        });
        this.cleanupSweep = new PeriodicSweep({
            intervalMs: this.cleanupIntervalMs,
            fn: () => this.cleanupStaleClients(),
            onError: (err) => this.logger.error('Presence cleanup error', err),
        });

        this.heartbeatSweep.start();
        this.cleanupSweep.start();
    }

    // ─── Inbound action dispatch ────────────────────────────────────────────

    async handleAction(clientId: string, action: string, data: any): Promise<void> {
        const startTime = Date.now();
        try {
            switch (action) {
                case 'set':
                    await this.handleSetPresence(clientId, data);
                    return;
                case 'get':
                    await this.handleGetPresence(clientId, data);
                    return;
                case 'subscribe':
                    await this.handleSubscribePresence(clientId, data);
                    return;
                case 'unsubscribe':
                    await this.handleUnsubscribePresence(clientId, data);
                    return;
                case 'heartbeat':
                    await this.handleHeartbeat(clientId, data);
                    return;
                default:
                    this.sendError(clientId, `Unknown presence action: ${action}`);
            }
        } catch (error) {
            this.logger.error(`Error handling presence action ${action} for client ${clientId}:`, error);
            this.sendError(clientId, 'Internal server error');
        } finally {
            const duration = Date.now() - startTime;
            this.logger.info(`[presence] ${action}`, { clientId, channel: data?.channel, duration });
            if (duration > 500) {
                this.logger.warn(`Slow message handler: presence/${action} took ${duration}ms`, { clientId });
            }
        }
    }

    async handleSetPresence(clientId: string, payload: PresenceUpdate): Promise<void> {
        const { status, metadata = {}, channels = [] } = payload || ({} as PresenceUpdate);

        if (!status) {
            this.sendError(clientId, 'Status is required');
            return;
        }
        if (!VALID_STATUSES.includes(status)) {
            this.sendError(clientId, `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
            return;
        }

        const validated = validateMetadata(metadata, this.maxMetadataKeys, this.maxMetadataSize, this.logger);

        const presenceData: PresenceEntry = {
            clientId,
            status,
            metadata: validated,
            channels,
            nodeId: this.messageRouter.nodeId || 'local',
            timestamp: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            lastHeartbeat: Date.now(),
        };

        this.clientPresence.set(clientId, presenceData);

        await this.updateChannelPresence(clientId, presenceData, channels);

        await this.broadcastPresenceUpdate(presenceData);

        this.sendToClient(clientId, {
            type: 'presence',
            action: 'set',
            presence: presenceData,
            timestamp: new Date().toISOString(),
        });

        this.logger.info(`Presence set for client ${clientId}: ${status}`);
    }

    async handleGetPresence(
        clientId: string,
        { targetClientId, channel }: { targetClientId?: string; channel?: string },
    ): Promise<void> {
        try {
            let presenceData: PresenceEntry | PresenceEntry[] | undefined;

            if (targetClientId) {
                presenceData = this.clientPresence.get(targetClientId);
                if (!presenceData) {
                    this.sendError(clientId, 'Client not found');
                    return;
                }
            } else if (channel) {
                presenceData = this.getChannelPresence(channel);
            } else {
                this.sendError(clientId, 'Either targetClientId or channel is required');
                return;
            }

            this.sendToClient(clientId, {
                type: 'presence',
                action: 'presence',
                data: presenceData,
                timestamp: new Date().toISOString(),
            });

            this.logger.debug(`Sent presence data to client ${clientId}`);
        } catch (error) {
            this.logger.error(`Error getting presence for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to get presence data');
        }
    }

    async handleSubscribePresence(clientId: string, { channel }: { channel: string }): Promise<void> {
        if (!channel) {
            this.sendError(clientId, 'Channel is required');
            return;
        }

        try {
            // Consumer-supplied authz hook replaces gateway's
            // enforceChannelPermission. Default-allow when no hook is wired.
            if (!this.authorizeChannel(clientId, channel)) {
                return;
            }

            await this.messageRouter.subscribeToChannel(clientId, `presence:${channel}`);

            const channelPresence = this.getChannelPresence(channel);
            this.sendToClient(clientId, {
                type: 'presence',
                action: 'subscribed',
                channel,
                presence: channelPresence,
                timestamp: new Date().toISOString(),
            });

            this.logger.info(`Client ${clientId} subscribed to presence for channel: ${channel}`);
        } catch (error) {
            this.logger.error(`Error subscribing to presence for client ${clientId}:`, error);
            this.sendError(clientId, 'Failed to subscribe to presence');
        }
    }

    async handleUnsubscribePresence(clientId: string, { channel }: { channel: string }): Promise<void> {
        if (!channel) {
            this.sendError(clientId, 'Channel is required');
            return;
        }

        await this.messageRouter.unsubscribeFromChannel(clientId, `presence:${channel}`);

        this.sendToClient(clientId, {
            type: 'presence',
            action: 'unsubscribed',
            channel,
            timestamp: new Date().toISOString(),
        });

        this.logger.info(`Client ${clientId} unsubscribed from presence for channel: ${channel}`);
    }

    async handleHeartbeat(clientId: string, _data: unknown): Promise<void> {
        const presenceData = this.clientPresence.get(clientId);
        if (presenceData) {
            presenceData.lastSeen = new Date().toISOString();
            presenceData.lastHeartbeat = Date.now();
            this.clientPresence.set(clientId, presenceData);
        }
    }

    // ─── Internal channel-presence bookkeeping ──────────────────────────────

    async updateChannelPresence(
        clientId: string,
        presenceData: PresenceEntry,
        newChannels: string[],
    ): Promise<void> {
        const oldChannels = this.clientChannels.get(clientId) || new Set<string>();
        const newChannelSet = new Set(newChannels);

        for (const channel of oldChannels) {
            if (!newChannelSet.has(channel)) {
                const channelMap = this.channelPresence.get(channel);
                if (channelMap) {
                    channelMap.delete(clientId);
                    if (channelMap.size === 0) this.channelPresence.delete(channel);
                }
            }
        }

        for (const channel of newChannels) {
            if (!this.channelPresence.has(channel)) {
                this.channelPresence.set(channel, new Map());
            }
            this.channelPresence.get(channel)!.set(clientId, presenceData);
        }

        this.clientChannels.set(clientId, newChannelSet);
    }

    removeClientFromAllChannels(clientId: string): void {
        const channels = this.clientChannels.get(clientId);
        if (channels) {
            for (const channel of channels) {
                const channelMap = this.channelPresence.get(channel);
                if (channelMap) {
                    channelMap.delete(clientId);
                    if (channelMap.size === 0) this.channelPresence.delete(channel);
                }
            }
            this.clientChannels.delete(clientId);
        }
    }

    getChannelPresence(channel: string): PresenceEntry[] {
        const channelPresenceMap = this.channelPresence.get(channel);
        if (!channelPresenceMap) return [];
        return Array.from(channelPresenceMap.values());
    }

    async broadcastPresenceUpdate(presenceData: PresenceEntry): Promise<void> {
        const { channels, clientId } = presenceData;

        const message = {
            type: 'presence',
            action: 'update',
            presence: presenceData,
            timestamp: new Date().toISOString(),
        };

        const redisAvailable = this.messageRouter.redisAvailable !== false;

        for (const channel of channels) {
            await this.messageRouter.sendToChannel(
                `presence:${channel}`,
                message,
                clientId,
            );
        }

        if (!redisAvailable && channels.length > 0) {
            this.logger.debug('Redis unavailable, presence update local only');
        }
    }

    // ─── Heartbeat + stale-client sweep ─────────────────────────────────────

    cleanupStalePresence(): void {
        const now = Date.now();
        const staleClients: string[] = [];

        for (const [clientId, presenceData] of this.clientPresence) {
            const lastSeen = new Date(presenceData.lastSeen).getTime();
            if (now - lastSeen > this.presenceTimeoutMs) {
                staleClients.push(clientId);
            }
        }

        for (const clientId of staleClients) {
            this.setClientOffline(clientId);
        }

        if (staleClients.length > 0) {
            this.logger.debug(`Marked ${staleClients.length} clients as offline due to inactivity`);
        }
    }

    cleanupStaleClients(): void {
        const now = Date.now();
        const entries = Array.from(this.clientPresence.entries());
        let cleaned = 0;

        for (const [clientId] of entries) {
            const currentEntry = this.clientPresence.get(clientId);
            if (!currentEntry || now - currentEntry.lastHeartbeat > this.staleThresholdMs) {
                this.clientPresence.delete(clientId);
                cleaned++;
                this.removeClientFromAllChannels(clientId);
            }
        }

        if (cleaned > 0) {
            this.logger.info(`Presence cleanup: removed ${cleaned} stale clients`);
        }
    }

    async setClientOffline(clientId: string): Promise<void> {
        const presenceData = this.clientPresence.get(clientId);
        if (presenceData && presenceData.status !== 'offline') {
            presenceData.status = 'offline';
            presenceData.timestamp = new Date().toISOString();

            await this.updateChannelPresence(clientId, presenceData, presenceData.channels);

            await this.broadcastPresenceUpdate(presenceData);

            this.logger.debug(`Client ${clientId} marked as offline due to inactivity`);
        }
    }

    // ─── Outbound helpers ───────────────────────────────────────────────────

    private sendToClient(clientId: string, message: unknown): void {
        this.messageRouter.sendToClient(clientId, message);
    }

    /**
     * Send a simple error frame. Gateway's version uses ErrorCodes +
     * metricsCollector — neither of which is exported from this package
     * (consumers can pre-wrap their MessageRouterContract's sendToClient
     * if they want richer error envelopes).
     */
    private sendError(clientId: string, message: string): void {
        this.sendToClient(clientId, {
            type: 'error',
            service: 'presence',
            message,
        });
    }

    // ─── Client lifecycle ───────────────────────────────────────────────────

    async onClientConnect(clientId: string): Promise<void> {
        // If the client is mid-disconnect (session-token reconnect inside
        // the disconnect delay), cancel the pending cleanup so the live
        // client's presence + channel memberships survive.
        if (this.disconnectEviction.isScheduled(clientId)) {
            this.disconnectEviction.cancel(clientId);
            this.logger.debug(`Cancelled pending disconnect timer for reconnected client ${clientId}`);
        }

        await this.handleSetPresence(clientId, {
            status: 'online',
            metadata: { connected: true },
            channels: [],
        });

        this.logger.debug(`Client ${clientId} connected to presence service`);
    }

    /** Alias for consumers that follow the server.js handleDisconnect naming. */
    async handleDisconnect(clientId: string): Promise<void> {
        return this.onClientDisconnect(clientId);
    }

    async onClientDisconnect(clientId: string): Promise<void> {
        const presenceData = this.clientPresence.get(clientId);
        if (presenceData) {
            await this.setClientOffline(clientId);

            const channels = this.clientChannels.get(clientId);
            if (channels) {
                const offlineMsg = {
                    type: 'presence',
                    action: 'offline',
                    clientId,
                    timestamp: new Date().toISOString(),
                };
                for (const channel of channels) {
                    await this.messageRouter.sendToChannel(
                        `presence:${channel}`,
                        offlineMsg,
                        clientId,
                    );
                }
            }

            // EvictionTimer.schedule cancels any prior timer for the same key,
            // eliminating the manual cancel-first pattern. Timer is auto-unref'd.
            this.disconnectEviction.schedule(clientId, () => {
                this.clientPresence.delete(clientId);
                this.removeClientFromAllChannels(clientId);
            });
        }

        this.logger.debug(`Client ${clientId} disconnected from presence service`);
    }

    // ─── Service lifecycle ──────────────────────────────────────────────────

    async shutdown(): Promise<void> {
        await this.heartbeatSweep.stop();
        await this.cleanupSweep.stop();
        this.disconnectEviction.cancelAll();

        this.clientPresence.clear();
        this.channelPresence.clear();
        this.clientChannels.clear();

        this.logger.info('Presence service shutdown complete');
    }

    getStats(): {
        connectedClients: number;
        activeChannels: number;
        statusBreakdown: Record<string, number>;
    } {
        const statusCounts: Record<string, number> = {};
        for (const presenceData of this.clientPresence.values()) {
            statusCounts[presenceData.status] = (statusCounts[presenceData.status] || 0) + 1;
        }

        return {
            connectedClients: this.clientPresence.size,
            activeChannels: this.channelPresence.size,
            statusBreakdown: statusCounts,
        };
    }
}

export = PresenceService;
