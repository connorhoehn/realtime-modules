import type { PresenceEntry } from './types';
/** Durable roster entries; the service must still verify each connection's
 * current identity/liveness and channel access before returning an entry. */
export interface PresenceStore {
    put(entry: PresenceEntry, ttlMs: number): Promise<void>;
    get(clientId: string): Promise<PresenceEntry | null>;
    list(channel: string): Promise<PresenceEntry[]>;
    remove(clientId: string): Promise<void>;
}
export interface PresenceRedis {
    command(...args: string[]): Promise<unknown>;
}
/** Namespace-isolated Redis roster storage. Client IDs must be globally
 * unique for a connection's lifetime, as required by RedisRealtimeRouter.
 * Expired channel-index members are pruned without removing a racing write. */
export declare class RedisPresenceStore implements PresenceStore {
    private readonly redis;
    private readonly prefix;
    constructor(redis: PresenceRedis, namespace: string);
    private key;
    private channel;
    put(entry: PresenceEntry, ttlMs: number): Promise<void>;
    get(clientId: string): Promise<PresenceEntry | null>;
    list(channel: string): Promise<PresenceEntry[]>;
    remove(clientId: string): Promise<void>;
}
//# sourceMappingURL=PresenceStore.d.ts.map