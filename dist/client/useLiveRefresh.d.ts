import type { LiveRefreshOptions } from './liveRefresh';
import type { SharedChannelState, SharedSocketChannelService, SharedSocketTransport } from './sharedSocketTransport';
import type { ConnectionState } from './types';
/** A socket for useLiveRefresh: `useSharedSocket()`'s value satisfies it. */
export interface LiveRefreshSocket {
    transport: SharedSocketTransport;
    /** Omitted: treated as connected. */
    connectionState?: ConnectionState;
    /**
     * The socket's session epoch. When given, an ack counts only in the session
     * it was seen in, so the render that reports a reconnect is not live on the
     * previous session's ack.
     */
    sessionEpoch?: number;
}
export interface UseLiveRefreshOptions<T> extends Pick<LiveRefreshOptions<T>, 'coalesceMs' | 'livePollMs' | 'pollMs' | 'maxBackoff' | 'onData' | 'onError'> {
    /** A channel to hold while mounted; live waits for its ack. Omitted: live = connected (frames the socket gets anyway). */
    channel?: string | null;
    /** The channel's subscribe service. Default: `pipeline` for `pipeline:*`, else `subscribe`. */
    service?: SharedSocketChannelService;
    /**
     * Which inbound frames re-read the record. Default with a `channel`: frames
     * whose `channel` is it (acks and errors excepted); without one, none.
     */
    isHint?: (frame: Record<string, unknown>) => boolean;
    /** Extra frames that refuse the channel (e.g. an error naming the router channel a wire channel maps to). */
    isRefusal?: (frame: Record<string, unknown>) => boolean;
    /** Overrides the provider. `null`: no socket, poll only. */
    socket?: LiveRefreshSocket | null;
    /** False: no reads, no hold. Default true. */
    enabled?: boolean;
    /** A change starts over (data cleared, read at once), as a `channel` change does. */
    key?: unknown;
}
export interface UseLiveRefreshResult<T> {
    /** The last successful read; undefined before the first (and after a channel / key change). */
    data: T | undefined;
    /** The last read's error; cleared by a success. */
    error: unknown;
    /** No data and no error yet. */
    loading: boolean;
    /** Connected and the channel acknowledged: hints drive reads, polling is the slow safety read. */
    live: boolean;
    /** The socket's state, or null without a socket. */
    connectionState: ConnectionState | null;
    /** The channel's state with the server (`'unheld'` without a channel). */
    channelState: SharedChannelState;
    /** Read now. */
    refresh: () => void;
}
/** Read a record, re-read it on frame hints while live, poll otherwise. See the file header. */
export declare function useLiveRefresh<T>(read: (signal: AbortSignal) => Promise<T>, options?: UseLiveRefreshOptions<T>): UseLiveRefreshResult<T>;
//# sourceMappingURL=useLiveRefresh.d.ts.map