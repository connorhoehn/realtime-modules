import { type CursorData, type CursorLogger, type CursorMessageRouter, type CursorMetricsCollector, type CursorModeConfig, type CursorServiceOptions, type CursorUpdate } from './types';
export declare class CursorService {
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
    private readonly cleanupSweep;
    supportedModes: Record<string, CursorModeConfig>;
    private authorizeChannel;
    constructor(opts: CursorServiceOptions);
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
    cleanupRoom(roomId: string): Promise<void>;
    handleAction(clientId: string, action: string, data: any): Promise<void>;
    handleUpdateCursor(clientId: string, { channel, position, metadata, mode }: CursorUpdate): Promise<void>;
    storeCursorData(clientId: string, channel: string, cursorData: CursorData): Promise<void>;
    storeLocalCursorData(clientId: string, channel: string, cursorData: CursorData): void;
    validatePositionForMode(position: any, mode: string): boolean;
    generateInitials(clientId: string): string;
    generateUserColor(clientId: string): string;
    handleGetModes(clientId: string, _data: unknown): Promise<void>;
    handleSubscribeCursors(clientId: string, { channel }: {
        channel: string;
    }): Promise<void>;
    handleUnsubscribeCursors(clientId: string, { channel }: {
        channel: string;
    }): Promise<void>;
    handleGetCursors(clientId: string, { channel }: {
        channel: string;
    }): Promise<void>;
    shouldUpdateCursor(clientId: string): boolean;
    getChannelCursors(channel: string): Promise<CursorData[]>;
    getLocalChannelCursors(channel: string): CursorData[];
    broadcastCursorUpdate(channel: string, cursorData: CursorData, excludeClientId: string): Promise<void>;
    sendToClient(clientId: string, message: unknown): void;
    sendError(clientId: string, message: string, errorCode?: string): void;
    onClientConnect(clientId: string): Promise<void>;
    onClientDisconnect(clientId: string): Promise<void>;
    removeCursorData(clientId: string): Promise<void>;
    removeLocalCursorData(clientId: string): Promise<void>;
    broadcastCursorRemoval(channel: string, clientId: string): Promise<void>;
    shutdown(): Promise<void>;
    cleanupStaleData(): void;
    removeStaleClientCursor(clientId: string): Promise<void>;
    getStats(): {
        connectedClients: number;
        activeChannels: number;
        isDistributed: boolean;
    };
}
export default CursorService;
//# sourceMappingURL=CursorService.d.ts.map