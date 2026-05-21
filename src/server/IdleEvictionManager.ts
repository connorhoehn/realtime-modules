// realtime-modules/src/server/IdleEvictionManager.ts
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

import { EvictionTimer } from 'distributed-core';
import { IDLE_EVICTION_MS } from './config';

class IdleEvictionManager {
    private logger: any;
    IDLE_EVICTION_MS: number;
    private _timer: any;

    /**
     * @param logger
     * @param config
     * @param config.idleEvictionMs - override for IDLE_EVICTION_MS
     */
    constructor(logger: any, config: { idleEvictionMs?: number; [key: string]: any } = {}) {
        this.logger = logger;
        this.IDLE_EVICTION_MS = config.idleEvictionMs || IDLE_EVICTION_MS;

        // DC primitive: unref-safe Map<key, Timeout> with schedule/cancel/cancelAll.
        this._timer = new EvictionTimer(this.IDLE_EVICTION_MS);
    }

    /**
     * Start an idle eviction timer for a channel.
     * After IDLE_EVICTION_MS the callback is invoked with the channel name.
     * No-ops if a timer is already running for the channel.
     *
     * @param channel
     * @param callback - receives the channel; should handle snapshot + cleanup
     */
    startEviction(channel: string, callback: (channel: string) => Promise<void>): void {
        // Preserve gateway's idempotent-start semantics: do NOT re-arm.
        if (this._timer.isScheduled(channel)) return;

        this._timer.schedule(channel, async (key: string) => {
            try {
                await callback(key);
            } catch (err: any) {
                this.logger.error(`Error during idle eviction callback for channel ${key}:`, err.message);
            }
        });
        this.logger.debug(`Idle eviction timer started for channel ${channel} (${this.IDLE_EVICTION_MS / 1000}s)`);
    }

    /**
     * Cancel an idle eviction timer for a channel (e.g. when a new subscriber joins).
     *
     * @param channel
     */
    cancelEviction(channel: string): void {
        if (this._timer.isScheduled(channel)) {
            this._timer.cancel(channel);
            this.logger.debug(`Idle eviction timer cancelled for channel ${channel}`);
        }
    }

    /**
     * Clear all pending eviction timers. Called during service shutdown.
     */
    shutdown(): void {
        this._timer.cancelAll();
        this.logger.debug('IdleEvictionManager shut down');
    }

    /**
     * @returns number of channels with active eviction timers
     */
    get pendingCount(): number {
        return this._timer.pendingCount;
    }
}

export = IdleEvictionManager;
