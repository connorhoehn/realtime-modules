import type { CursorEntry, GatewayMessage } from './types';
export interface UseCursorOpts {
    /**
     * Cursor mode — `freeform` | `table` | `text` | `canvas`. Decides which
     * position fields the service requires: freeform/canvas need {x,y}, table
     * needs {row,col}, text needs {position}. Default `freeform`.
     */
    mode?: string;
    /**
     * Metadata merged into every update. `userInitials` and `userColor` are
     * what an overlay labels the cursor with; omit them and the service
     * derives both from the connection id.
     */
    metadata?: Record<string, unknown>;
    /**
     * Your own client id. When given, a cursor carrying it is filtered out of
     * `cursors` — the subscribe snapshot is the server's full channel map and
     * may still hold a stale entry of yours. Default: no filtering.
     */
    selfClientId?: string;
    /**
     * Minimum gap (ms) between updates actually sent. Default 250, matching
     * the service's own throttle. Set this only if the server's
     * CURSOR_THROTTLE_INTERVAL_MS was changed — a smaller value here just
     * means the service drops the extra frames.
     */
    throttleMs?: number;
    /**
     * Send/receive handles when the caller holds the socket itself. Given, the
     * hook never touches GatewaySocketProvider context, so it renders in a
     * subtree with no provider (a canvas inside a call, a component test).
     */
    socket?: {
        send: (message: Record<string, unknown>) => void;
        onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
    };
}
export interface UseCursorReturn {
    /** Live cursors for the channel, excluding your own. */
    cursors: CursorEntry[];
    /**
     * Publish your position. Throttled to opts.throttleMs; a suppressed call
     * is held and sent when the window opens, so the resting position always
     * lands. Per-call metadata is merged over the hook-level metadata.
     */
    move: (position: Record<string, unknown>, metadata?: Record<string, unknown>) => void;
    /** Re-ask the service for the channel's current cursors. */
    refresh: () => void;
}
export declare function useCursor(channel: string, opts?: UseCursorOpts): UseCursorReturn;
//# sourceMappingURL=useCursor.d.ts.map