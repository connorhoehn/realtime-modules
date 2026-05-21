import type { ActivityEvent } from './types';
export interface ActivityHistoryStore {
    /**
     * Append `event` to the head of `channelId`'s history. Implementations
     * cap the list to the service's `maxHistoryItems` and may apply a TTL.
     */
    append(channelId: string, event: ActivityEvent): Promise<void>;
    /**
     * Read the most-recent `limit` events for `channelId`, newest first.
     * Returns an empty array if the channel is unknown or the transport
     * errors.
     */
    list(channelId: string, limit: number): Promise<ActivityEvent[]>;
}
/**
 * Zero-config in-memory implementation. Intended for unit tests, dev mode
 * with backing services off, and embedded consumers that don't want
 * Redis. Per-channel arrays kept in insertion (newest-first) order, hard-
 * capped by the per-store `maxItems` cap (defaults to 200, matching the
 * gateway constant).
 */
export declare class InMemoryActivityHistoryStore implements ActivityHistoryStore {
    private readonly entries;
    private readonly maxItems;
    constructor(maxItems?: number);
    append(channelId: string, event: ActivityEvent): Promise<void>;
    list(channelId: string, limit: number): Promise<ActivityEvent[]>;
    /** Test helper — clears every channel. Not part of ActivityHistoryStore. */
    _reset(): void;
}
//# sourceMappingURL=ActivityHistoryStore.d.ts.map