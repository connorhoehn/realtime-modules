"use strict";
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
const distributed_core_1 = require("distributed-core");
const config_1 = require("./config");
class IdleEvictionManager {
    logger;
    IDLE_EVICTION_MS;
    _timer;
    /**
     * @param logger
     * @param config
     * @param config.idleEvictionMs - override for IDLE_EVICTION_MS
     */
    constructor(logger, config = {}) {
        this.logger = logger;
        this.IDLE_EVICTION_MS = config.idleEvictionMs || config_1.IDLE_EVICTION_MS;
        // DC primitive: unref-safe Map<key, Timeout> with schedule/cancel/cancelAll.
        this._timer = new distributed_core_1.EvictionTimer(this.IDLE_EVICTION_MS);
    }
    /**
     * Start an idle eviction timer for a channel.
     * After IDLE_EVICTION_MS the callback is invoked with the channel name.
     * No-ops if a timer is already running for the channel.
     *
     * @param channel
     * @param callback - receives the channel; should handle snapshot + cleanup
     */
    startEviction(channel, callback) {
        // Preserve gateway's idempotent-start semantics: do NOT re-arm.
        if (this._timer.isScheduled(channel))
            return;
        this._timer.schedule(channel, async (key) => {
            try {
                await callback(key);
            }
            catch (err) {
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
    cancelEviction(channel) {
        if (this._timer.isScheduled(channel)) {
            this._timer.cancel(channel);
            this.logger.debug(`Idle eviction timer cancelled for channel ${channel}`);
        }
    }
    /**
     * Clear all pending eviction timers. Called during service shutdown.
     */
    shutdown() {
        this._timer.cancelAll();
        this.logger.debug('IdleEvictionManager shut down');
    }
    /**
     * @returns number of channels with active eviction timers
     */
    get pendingCount() {
        return this._timer.pendingCount;
    }
}
module.exports = IdleEvictionManager;
//# sourceMappingURL=IdleEvictionManager.js.map