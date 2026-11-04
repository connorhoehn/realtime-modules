/** The service that owns a channel's subscribe / unsubscribe frames. */
export type SharedSocketChannelService = 'pipeline' | 'subscribe';
/** An outbound frame as the socket's `send` takes it. */
export type SharedSocketFrame = Record<string, unknown>;
export interface SharedSocketTransportOptions {
    /** The socket's send (`useWebSocket().send`). Omitted: frames are dropped and subscriptions held until `update({ send })`. */
    send?: (frame: SharedSocketFrame) => void;
    /**
     * The socket's session epoch (`useWebSocket().sessionEpoch`). `0` means no
     * session yet: subscriptions are held, not sent. Each new value re-sends
     * every held channel once. Undefined: no session tracking — a channel is
     * sent on its first hold and the socket's lifecycle is the owner's.
     */
    sessionEpoch?: number;
    /** Extra gate on subscription frames, e.g. `() => ws.connectionState === 'connected'`. Call `resubscribe()` when it turns true. */
    isOpen?: () => boolean;
    /**
     * When a last release's unsubscribe is sent. Default `queueMicrotask`: a
     * release followed by a hold of the same channel in the same tick (React
     * re-running an effect, or every consumer re-running on a new epoch) sends
     * nothing. Pass `(flush) => flush()` to send it immediately.
     */
    scheduleRelease?: (flush: () => void) => void;
    /** A handler threw while a frame was fanned out. Default `console.error`. The other handlers still run. */
    onHandlerError?: (error: unknown, frame: unknown) => void;
}
export interface SharedSocketSubscribeOptions {
    /** Default: `'pipeline'` for `pipeline:*` channels, else `'subscribe'`. The first holder's service is used while the channel is held. */
    service?: SharedSocketChannelService;
}
/**
 * The `{ send, onMessage }` shape `usePipelineRunStatus` / `usePipelineCatalog`
 * take as `transport` (structurally `PipelineRunTransport`). Subscribe and
 * unsubscribe frames sent through it become holds and releases on the shared
 * transport, so they must be paired — the library hooks pair them.
 */
export interface SharedPipelineRunTransport {
    send: (frame: unknown) => void;
    onMessage: (fn: (frame: unknown) => void) => () => void;
}
/**
 * The `{ subscribe, unsubscribe }` shape ui-components' `EventStreamProvider`
 * takes as `channelTransport` (structurally `EventStreamChannelTransport`).
 * Stable identity: re-subscription after a reconnect is the shared
 * transport's job, so the provider's subscribers never re-run for it.
 */
export interface SharedChannelTransport {
    subscribe: (channel: string) => void;
    unsubscribe: (channel: string) => void;
}
export interface SharedSocketTransport {
    /** Hand every inbound frame here — pass it as the socket's `onMessage`. Stable. */
    deliver: (frame: unknown) => void;
    /** Register a handler for every inbound frame. Returns the unregister. */
    onMessage: (handler: (frame: unknown) => void) => () => void;
    /** Hold a channel. The first hold sends the subscribe frame; the returned release (idempotent) lets go, and the last release sends the unsubscribe. */
    subscribe: (channel: string, options?: SharedSocketSubscribeOptions) => () => void;
    /** Send a frame as is (no refcounting). Dropped while there is no `send`. */
    send: (frame: SharedSocketFrame) => void;
    /** Re-bind the socket. A changed `sessionEpoch` re-sends every held channel. */
    update: (options: Pick<SharedSocketTransportOptions, 'send' | 'sessionEpoch' | 'isOpen'>) => void;
    /** Re-send the subscribe frame of every held channel (for an `isOpen` host whose socket just opened). */
    resubscribe: () => void;
    /** Send the pending last-release unsubscribes now. */
    flush: () => void;
    /** The epoch last given, or undefined. */
    readonly sessionEpoch: number | undefined;
    /** Held channels and their hold counts. */
    holds: () => Map<string, number>;
    /** The `{ send, onMessage }` adapter for the pipeline hooks. One per transport. */
    asPipelineRunTransport: () => SharedPipelineRunTransport;
    /** The `{ subscribe, unsubscribe }` adapter for `EventStreamProvider`. One per transport. */
    asChannelTransport: () => SharedChannelTransport;
}
/** `'pipeline'` for `pipeline:*` channels, else `'subscribe'`. */
export declare function defaultChannelService(channel: string): SharedSocketChannelService;
/** One host socket, shared: fan-out, refcounted channels, re-subscription per session epoch. */
export declare function createSharedSocketTransport(options?: SharedSocketTransportOptions): SharedSocketTransport;
//# sourceMappingURL=sharedSocketTransport.d.ts.map