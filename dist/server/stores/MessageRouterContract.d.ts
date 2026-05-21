/**
 * Prep interface for the CRDT-extraction Cut 1.
 *
 * `MessageRouterContract` abstracts the slice of the real `MessageRouter`
 * that CRDT modules actually use today:
 *
 *   - `sendToChannel` — DocumentMetadataService uses it to broadcast the
 *     `doc.created` activity envelope (wave20-e). The full router exposes
 *     many more channels and a richer signature; CRDT only needs the
 *     per-channel publish.
 *
 *   - `broadcastToAll` — kept on the contract because Cut 1 plans to
 *     route the `documentCleared` / restore notifications through the
 *     router instead of the orchestrator's ad-hoc client loop. (Today
 *     the crdt-service does this directly via `sendToClient`; that
 *     coupling goes away in Cut 1.)
 *
 *   - `onRemoteChannelMessage` — crdt-service.ts:184-205 registers a
 *     `'crdt-sync'` handler so cross-node updates land on the local
 *     Y.Doc. The real router invokes the handler with
 *     `(channel, message, fromNode)`; this contract narrows that to a
 *     single `payload` argument so the CRDT module doesn't depend on
 *     router-internal `fromNode` semantics. Cut 1's adapter wraps the
 *     real router's 3-arg handler and packs `{ channel, message }` into
 *     `payload`.
 *
 *   - `getClientData` — optional, present on the real router. Currently
 *     unused inside the crdt/ directory but the orchestrator surrounding
 *     CRDT reads `userId` / `displayName` off it to populate the
 *     `createdByName` / activity-author fields. Kept on the contract so
 *     Cut 1 can move those reads inward without widening the interface.
 *
 * Purely additive — neither crdt-service.ts nor the real MessageRouter is
 * modified. The actual swap (replace `messageRouter: any` ctor param with
 * `MessageRouterContract`) happens in Cut 1.
 */
export interface MessageRouterContract {
    /** Publish a frame to a logical channel (e.g. `activity:broadcast`). */
    sendToChannel(channel: string, frame: unknown): Promise<void>;
    /**
     * Broadcast a frame to every connected client on every node.
     * Used for global notifications (e.g. document-cleared) so all live
     * sessions converge without a per-channel subscribe.
     */
    broadcastToAll(frame: unknown): Promise<void>;
    /**
     * Register a handler for cross-node messages of the given
     * `messageType`. The handler is called once per delivery, with the
     * payload the remote node published.
     *
     * Implementations MUST tolerate both sync and async handlers.
     */
    onRemoteChannelMessage(messageType: string, handler: (payload: unknown) => void | Promise<void>): void;
    /**
     * Optional. Returns the connected-client identity context, or `null`
     * when the client is unknown (disconnected, unauthenticated, or the
     * router implementation doesn't expose identity).
     */
    getClientData?(clientId: string): {
        userId?: string;
        displayName?: string;
    } | null;
}
//# sourceMappingURL=MessageRouterContract.d.ts.map