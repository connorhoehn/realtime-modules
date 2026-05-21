/**
 * Manages idle Y.Doc eviction timers. When a CRDT channel has 0 subscribers,
 * a timer starts. After IDLE_EVICTION_MS (default 10 minutes), the provided
 * callback fires to write a final snapshot and evict the Y.Doc from memory.
 *
 * Thin wrapper around DC's `EvictionTimer` (gateway/eviction). DC's primitive
 * is unref-safe and exposes schedule/cancel/cancelAll. This wrapper preserves
 * the gateway's existing public surface (startEviction / cancelEviction /
 * shutdown / pendingCount) AND its idempotent-start semantics (a second
 * startEviction call while a timer is already running is a no-op, NOT a
 * re-arm — DC's schedule() always re-arms).
 *
 * Lift note (CRDT Cut 1): copied verbatim from
 * src/realtime-fanout/crdt/IdleEvictionManager.ts. No logic changes.
 */
declare class IdleEvictionManager {
    private logger;
    IDLE_EVICTION_MS: number;
    private _timer;
    /**
     * @param logger
     * @param config
     * @param config.idleEvictionMs - override for IDLE_EVICTION_MS
     */
    constructor(logger: any, config?: {
        idleEvictionMs?: number;
        [key: string]: any;
    });
    /**
     * Start an idle eviction timer for a channel.
     * After IDLE_EVICTION_MS the callback is invoked with the channel name.
     * No-ops if a timer is already running for the channel.
     *
     * @param channel
     * @param callback - receives the channel; should handle snapshot + cleanup
     */
    startEviction(channel: string, callback: (channel: string) => Promise<void>): void;
    /**
     * Cancel an idle eviction timer for a channel (e.g. when a new subscriber joins).
     *
     * @param channel
     */
    cancelEviction(channel: string): void;
    /**
     * Clear all pending eviction timers. Called during service shutdown.
     */
    shutdown(): void;
    /**
     * @returns number of channels with active eviction timers
     */
    get pendingCount(): number;
}
export = IdleEvictionManager;
//# sourceMappingURL=IdleEvictionManager.d.ts.map