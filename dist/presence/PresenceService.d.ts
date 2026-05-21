import { EvictionTimer } from 'distributed-core';
import type { PresenceConfig, PresenceEntry, PresenceLogger, PresenceMessageRouter, PresenceUpdate } from './types';
declare class PresenceService {
    private messageRouter;
    private logger;
    private authorizeChannel;
    private readonly heartbeatIntervalMs;
    private readonly presenceTimeoutMs;
    private readonly staleThresholdMs;
    private readonly cleanupIntervalMs;
    private readonly disconnectDelayMs;
    private readonly maxMetadataKeys;
    private readonly maxMetadataSize;
    clientPresence: Map<string, PresenceEntry>;
    channelPresence: Map<string, Map<string, PresenceEntry>>;
    clientChannels: Map<string, Set<string>>;
    readonly disconnectEviction: EvictionTimer;
    private readonly heartbeatSweep;
    private readonly cleanupSweep;
    constructor(messageRouter: PresenceMessageRouter, logger: PresenceLogger, config?: PresenceConfig);
    handleAction(clientId: string, action: string, data: any): Promise<void>;
    handleSetPresence(clientId: string, payload: PresenceUpdate): Promise<void>;
    handleGetPresence(clientId: string, { targetClientId, channel }: {
        targetClientId?: string;
        channel?: string;
    }): Promise<void>;
    handleSubscribePresence(clientId: string, { channel }: {
        channel: string;
    }): Promise<void>;
    handleUnsubscribePresence(clientId: string, { channel }: {
        channel: string;
    }): Promise<void>;
    handleHeartbeat(clientId: string, _data: unknown): Promise<void>;
    updateChannelPresence(clientId: string, presenceData: PresenceEntry, newChannels: string[]): Promise<void>;
    removeClientFromAllChannels(clientId: string): void;
    getChannelPresence(channel: string): PresenceEntry[];
    broadcastPresenceUpdate(presenceData: PresenceEntry): Promise<void>;
    cleanupStalePresence(): void;
    cleanupStaleClients(): void;
    setClientOffline(clientId: string): Promise<void>;
    private sendToClient;
    /**
     * Send a simple error frame. Gateway's version uses ErrorCodes +
     * metricsCollector — neither of which is exported from this package
     * (consumers can pre-wrap their MessageRouterContract's sendToClient
     * if they want richer error envelopes).
     */
    private sendError;
    onClientConnect(clientId: string): Promise<void>;
    /** Alias for consumers that follow the server.js handleDisconnect naming. */
    handleDisconnect(clientId: string): Promise<void>;
    onClientDisconnect(clientId: string): Promise<void>;
    shutdown(): Promise<void>;
    getStats(): {
        connectedClients: number;
        activeChannels: number;
        statusBreakdown: Record<string, number>;
    };
}
export = PresenceService;
//# sourceMappingURL=PresenceService.d.ts.map