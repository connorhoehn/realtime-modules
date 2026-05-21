// realtime-modules/src/presence/types.ts
//
// Types for the lifted in-process PresenceService.
//
// Lift scope (Wave 2): only the in-memory tracking surface is lifted.
// Gateway-specific concerns left behind:
//   - presenceRegistry dual-write to DC's EntityRegistry
//     (gated by WSG_PRESENCE_REGISTRY_ENABLED)
//   - ownership-cleanup-coordinator integration (_flushRoomPresence)
//   - Redis pub/sub fanout details (consumers wire any
//     MessageRouterContract implementation)
//
// See manifest.ts for tunable env vars.

/**
 * The wire shape stored in `clientPresence` and broadcast to channel
 * subscribers. Field set is preserved from gateway's original presence
 * service so consumers and tests remain byte-identical at the WS layer.
 */
export interface PresenceEntry {
    clientId: string;
    status: PresenceStatus;
    metadata: Record<string, unknown>;
    channels: string[];
    nodeId: string;
    timestamp: string;     // ISO-8601 — last status mutation
    lastSeen: string;      // ISO-8601 — last heartbeat or set
    lastHeartbeat: number; // epoch ms — fast TTL comparison source
}

/** Allowed status values. Anything else is rejected by handleSetPresence. */
export type PresenceStatus = 'online' | 'away' | 'busy' | 'offline';

/**
 * Payload of an inbound `set` action. `channels` defaults to [].
 */
export interface PresenceUpdate {
    status: PresenceStatus;
    metadata?: Record<string, unknown>;
    channels?: string[];
}

/**
 * Optional construction-time tunables. All defaults come from
 * `manifest.ts` env-var declarations; this is the runtime-override path
 * (mainly for tests). When omitted, the service reads the same env vars
 * declared by PresenceManifest.
 */
export interface PresenceConfig {
    /** Heartbeat sweep interval (ms). Default 30_000. */
    heartbeatIntervalMs?: number;
    /** Inactivity threshold before a client is auto-flipped to offline (ms). Default 60_000. */
    presenceTimeoutMs?: number;
    /** Idle-client eviction TTL (ms). Default 90_000. */
    staleThresholdMs?: number;
    /** Cleanup-sweep interval for stale clients (ms). Default 30_000. */
    cleanupIntervalMs?: number;
    /** Delay after disconnect before purging client state (ms). Default 5_000. */
    disconnectDelayMs?: number;
    /** Max metadata keys before truncation. Default 20. */
    maxMetadataKeys?: number;
    /** Max metadata serialized size before truncation (bytes). Default 4096. */
    maxMetadataSize?: number;
    /**
     * Authorization hook. Called before honouring a subscribe-presence
     * action. Return false to silently drop. Default: allow all.
     *
     * Replaces gateway's authz-interceptor coupling: consumers wire any
     * policy they like (e.g. presence registry, RBAC, OAuth scopes).
     */
    authorizeChannel?: (clientId: string, channel: string) => boolean;
}

/**
 * The MessageRouter slice this service needs. Identical to the contract
 * the CRDT modules use (re-exported from `../server/stores/MessageRouterContract`),
 * extended with the sendToClient + per-client subscribe verbs presence
 * actually requires. Kept narrow on purpose — no AWS, no Redis, no
 * connection registry.
 */
export interface PresenceMessageRouter {
    sendToClient(clientId: string, message: unknown): void;
    sendToChannel(channel: string, message: unknown, excludeClientId?: string): void | Promise<void>;
    subscribeToChannel(clientId: string, channel: string): void | Promise<void>;
    unsubscribeFromChannel(clientId: string, channel: string): void | Promise<void>;
    /**
     * Optional: when undefined the service treats itself as "single node"
     * and falls back to 'local' for the `nodeId` field on PresenceEntry.
     */
    nodeId?: string;
    /**
     * Optional Redis-availability hint used purely for a debug log.
     * Defaults to true (assume the router can fan-out).
     */
    redisAvailable?: boolean;
}

/**
 * Logger contract. Matches the project's pino-like surface; pass a
 * NoopLogger in tests or wherever logs are unwanted.
 */
export interface PresenceLogger {
    debug(msg: string, meta?: unknown): void;
    info(msg: string, meta?: unknown): void;
    warn(msg: string, meta?: unknown): void;
    error(msg: string, error?: unknown): void;
}
