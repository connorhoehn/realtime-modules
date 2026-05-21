"use strict";
// realtime-modules/src/server/AwarenessCoalescer.ts
/**
 * Buffers awareness updates per channel in a coalescing window (default 50ms),
 * then broadcasts a single merged payload instead of one message per client.
 * Reduces Redis pub/sub volume significantly at scale.
 *
 * Thin wrapper around DC's `UpdateCoalescer` (gateway/coalescing). DC owns the
 * unref-safe per-key timer + window/flush loop; this wrapper supplies the
 * awareness-specific semantics:
 *   - latest-update-per-client wins (we maintain a per-channel
 *     Map<clientId, update> so we never buffer duplicates)
 *   - `removeClient(clientId)` ghost-cursor pruning (surgical mutation of
 *     the per-channel maps)
 *
 * DC's UpdateCoalescer doesn't expose mid-window buffer mutation (no per-item
 * removal), and its `merge` hook isn't passed the key — so we keep the buffer
 * ourselves and hand DC a sentinel just to drive the timer.
 *
 * Lift note (CRDT Cut 1): copied verbatim from
 * src/realtime-fanout/crdt/AwarenessCoalescer.ts. The `messageRouter`
 * parameter narrows to `MessageRouterContract` (only sendToChannel is
 * actually called). No logic changes.
 */
const distributed_core_1 = require("distributed-core");
const config_1 = require("./config");
// Sentinel pushed into DC's buffer purely to drive its window timer.
// We never read it back; the real buffer lives in `_batches`.
const TICK = 1;
class AwarenessCoalescer {
    messageRouter;
    logger;
    _batches;
    _coalescer;
    /**
     * @param messageRouter - message router for sendToChannel
     * @param logger
     */
    constructor(messageRouter, logger) {
        this.messageRouter = messageRouter;
        this.logger = logger;
        // channel -> Map<clientId, base64Update>. Latest-wins per clientId;
        // surgical mutation by removeClient.
        this._batches = new Map();
        // DC primitive: unref-safe per-key timer + window/flush loop. We use
        // it purely as a timer driver — actual updates live in `_batches`.
        this._coalescer = new distributed_core_1.UpdateCoalescer({
            windowMs: config_1.AWARENESS_BATCH_WINDOW_MS,
            onFlush: (channel) => this._broadcast(channel),
        });
    }
    /**
     * Buffer an awareness update for coalescing.
     * Only the latest update per client is kept (overwrites previous).
     * A flush is auto-scheduled after AWARENESS_BATCH_WINDOW_MS of the first
     * buffered update in the window.
     *
     * @param clientId
     * @param channel
     * @param update - base64-encoded awareness state
     */
    bufferUpdate(clientId, channel, update) {
        let batch = this._batches.get(channel);
        if (!batch) {
            batch = new Map();
            this._batches.set(channel, batch);
        }
        batch.set(clientId, update);
        // Drive DC's timer (idempotent within a window — DC only opens a new
        // window when no timer is currently scheduled for the key).
        this._coalescer.buffer(channel, TICK);
    }
    /**
     * Remove a disconnected client's buffered awareness state from all channels.
     * Without this, the next flush would re-broadcast the disconnected client's
     * last awareness state, causing other tabs to render "ghost" cursors for
     * clients that have already left.
     *
     * @param clientId
     * @returns number of channel batches the client was removed from
     */
    removeClient(clientId) {
        let removed = 0;
        for (const batch of this._batches.values()) {
            if (batch.delete(clientId)) {
                removed++;
            }
        }
        if (removed > 0) {
            this.logger.debug(`Awareness state pruned for disconnected client ${clientId} across ${removed} channel(s)`);
        }
        return removed;
    }
    /**
     * Flush all pending awareness batches immediately and clear timers.
     * Called during service shutdown.
     */
    shutdown() {
        this._coalescer.cancelAll();
        this._batches.clear();
        this.logger.debug('AwarenessCoalescer shut down');
    }
    /**
     * @returns number of channels with pending awareness batches
     */
    get pendingCount() {
        return this._batches.size;
    }
    // ---- internals -------------------------------------------------------
    /**
     * Broadcast coalesced awareness updates for a channel. Invoked by DC
     * when its window timer fires.
     */
    async _broadcast(channel) {
        const batch = this._batches.get(channel);
        this._batches.delete(channel);
        if (!batch || batch.size === 0) {
            // All buffered clients were pruned via removeClient — nothing to broadcast.
            return;
        }
        try {
            const merged = [];
            for (const [clientId, update] of batch) {
                merged.push({ clientId, update });
            }
            await this.messageRouter.sendToChannel(channel, {
                type: 'crdt:awareness',
                channel,
                updates: merged,
            });
            this.logger.debug(`Awareness flushed for channel ${channel}: ${merged.length} client(s)`);
        }
        catch (error) {
            this.logger.error(`Error flushing awareness batch for channel ${channel}:`, error);
        }
    }
}
module.exports = AwarenessCoalescer;
//# sourceMappingURL=AwarenessCoalescer.js.map