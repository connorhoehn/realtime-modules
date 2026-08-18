/**
 * CRDT Service — slim orchestrator that delegates to extracted sub-modules.
 *
 * Lift note (CRDT Cut 1): adapted verbatim from
 * src/realtime-fanout/crdt-service.ts (gateway origin). Logic-changes
 * vs. the gateway original are isolated to the constructor wiring:
 *
 *   - The `(messageRouter, logger, metricsCollector, redisClient,
 *     dynamoClient)` positional ctor is replaced with a single
 *     options-bag ctor that takes the three stores
 *     (`snapshotStore`, `metadataStore`, `hotCache`) and a
 *     `MessageRouterContract`. Gateway-specific AWS-SDK / Redis client
 *     wiring is gone — the adapters own that.
 *   - The `enforceChannelPermission` import (which lives in the
 *     gateway's authz middleware) becomes an optional `authz` hook on
 *     the options bag. Defaults to a permissive pass-through so the
 *     lifted module is usable in tests / zero-config consumers.
 *   - `ErrorCodes` / `createErrorResponse` from gateway/utils are
 *     inlined as minimal constants so the lifted module has no
 *     gateway-source imports.
 *
 * Everything else — handleAction dispatch, hydration flow, R2 bug #7
 * remote-update buffering, operation coalescer, periodic snapshot sweep,
 * shutdown — is preserved verbatim.
 */
import * as Y from 'yjs';
import DocumentMetadataService from './DocumentMetadataService';
import SnapshotManager from './SnapshotManager';
import AwarenessCoalescer from './AwarenessCoalescer';
import DocumentPresenceService from './DocumentPresenceService';
import IdleEvictionManager from './IdleEvictionManager';
import type { HotCache, SnapshotStore } from './stores/SnapshotStore';
import type { MetadataStore } from './stores/MetadataStore';
import type { MessageRouterContract } from './stores/MessageRouterContract';
interface ChannelState {
    ydoc: Y.Doc;
    operationsSinceSnapshot: number;
    subscriberCount: number;
    hydrated: boolean;
}
export interface OrchestratorMessageRouter extends MessageRouterContract {
    subscribeToChannel?(clientId: string, channel: string): Promise<void> | void;
    unsubscribeFromChannel?(clientId: string, channel: string): Promise<void> | void;
    sendToClient?(clientId: string, message: any): void;
}
export interface CRDTServiceOpts {
    messageRouter: OrchestratorMessageRouter;
    snapshotStore: SnapshotStore;
    metadataStore: MetadataStore;
    hotCache?: HotCache | null;
    logger: any;
    metricsCollector?: any;
    /**
     * Optional authz hook. Returns true if the client is permitted to access
     * the channel; false (after sending its own error message) otherwise.
     * Defaults to permissive.
     */
    authz?: (clientId: string, channel: string, service: CRDTService) => boolean;
}
declare class CRDTService {
    messageRouter: OrchestratorMessageRouter;
    logger: any;
    metricsCollector: any;
    channelStates: Map<string, ChannelState>;
    pendingRemoteUpdates: Map<string, Uint8Array[]>;
    PENDING_REMOTE_UPDATES_CAP: number;
    operationCoalescer: any;
    metadataService: DocumentMetadataService;
    snapshotManager: SnapshotManager;
    awarenessCoalescer: AwarenessCoalescer;
    presenceService: DocumentPresenceService;
    evictionManager: IdleEvictionManager;
    _evictionCallback: (channel: string) => Promise<void>;
    private readonly _snapshotSweep;
    private _authz;
    constructor(opts: CRDTServiceOpts);
    _applyRemoteUpdate(channel: string, state: ChannelState, updateBytes: Uint8Array): void;
    _bufferRemoteUpdate(channel: string, updateBytes: Uint8Array): void;
    _drainPendingRemoteUpdates(channel: string, state: ChannelState): number;
    handleAction(clientId: string, action: string, data: any): Promise<void>;
    handleSubscribe(clientId: string, { channel }: {
        channel: string;
    }): Promise<void>;
    handleUpdate(clientId: string, { channel, update }: {
        channel: string;
        update: string;
    }): Promise<void>;
    handleUnsubscribe(clientId: string, { channel }: {
        channel: string;
    }): Promise<void>;
    handleGetSnapshot(clientId: string, { channel }: {
        channel: string;
    }): Promise<void>;
    handleAwareness(clientId: string, { channel, update, idle, mode }: {
        channel: string;
        update: string;
        idle?: boolean;
        mode?: string;
    }): Promise<void>;
    handleDisconnect(clientId: string): Promise<void>;
    onClientDisconnect(clientId: string): Promise<void>;
    _broadcastCoalescedOps(channel: string, items: any[]): Promise<void>;
    _writePeriodicSnapshots(): Promise<void>;
    _validateChannel(channel: any): boolean;
    _requireAuth(clientId: string, actionName: string): boolean;
    sendToClient(clientId: string, message: any): void;
    sendError(clientId: string, message: string, errorCode?: any): void;
    shutdown(): Promise<void>;
    getStats(): Record<string, number>;
}
export default CRDTService;
export { CRDTService };
//# sourceMappingURL=CRDTService.d.ts.map