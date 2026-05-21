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
import type { MessageRouterContract } from './stores/MessageRouterContract';
declare class AwarenessCoalescer {
    private messageRouter;
    private logger;
    private _batches;
    private _coalescer;
    /**
     * @param messageRouter - message router for sendToChannel
     * @param logger
     */
    constructor(messageRouter: MessageRouterContract, logger: any);
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
    bufferUpdate(clientId: string, channel: string, update: string): void;
    /**
     * Remove a disconnected client's buffered awareness state from all channels.
     * Without this, the next flush would re-broadcast the disconnected client's
     * last awareness state, causing other tabs to render "ghost" cursors for
     * clients that have already left.
     *
     * @param clientId
     * @returns number of channel batches the client was removed from
     */
    removeClient(clientId: string): number;
    /**
     * Flush all pending awareness batches immediately and clear timers.
     * Called during service shutdown.
     */
    shutdown(): void;
    /**
     * @returns number of channels with pending awareness batches
     */
    get pendingCount(): number;
    /**
     * Broadcast coalesced awareness updates for a channel. Invoked by DC
     * when its window timer fires.
     */
    private _broadcast;
}
export = AwarenessCoalescer;
//# sourceMappingURL=AwarenessCoalescer.d.ts.map