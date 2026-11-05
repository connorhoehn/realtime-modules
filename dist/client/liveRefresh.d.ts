export declare const DEFAULT_LIVE_REFRESH_POLL_MS = 5000;
export declare const DEFAULT_LIVE_REFRESH_LIVE_POLL_MS = 30000;
/** The backoff ceiling, as a multiple of the cadence. */
export declare const MAX_LIVE_REFRESH_BACKOFF = 5;
/** Injected timers (tests, or a host scheduler). Defaults to the global setTimeout/clearTimeout. */
export interface LiveRefreshTimers {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
}
export interface LiveRefreshOptions<T> {
    /** Read the record. The signal aborts when the read is superseded by dispose(). */
    read: (signal: AbortSignal) => Promise<T>;
    /** Which frames passed to `hint(frame)` count. Omitted: every hint counts. */
    isHint?: (frame: unknown) => boolean;
    /** Hints within this window collapse into one read. Default 0 (read at once; still one in flight + one queued). */
    coalesceMs?: number;
    /** Safety read while live. Default 30 000; 0 turns it off. */
    livePollMs?: number;
    /** Poll while not live. Default 5 000; 0 turns it off. */
    pollMs?: number;
    /** Backoff ceiling as a multiple of the cadence, clamped to 1–5. Default 5. */
    maxBackoff?: number;
    /** Start live. Default false. */
    live?: boolean;
    /** Start hidden. Default: `document.hidden` (false outside a browser). */
    hidden?: boolean;
    /** Read once on creation. Default true. */
    immediate?: boolean;
    /** Each successful read's value. */
    onData?: (value: T) => void;
    /** Each failed read's error. */
    onError?: (error: unknown) => void;
    /** Clock. Default Date.now. */
    now?: () => number;
    /** Timers. Default the global setTimeout / clearTimeout. */
    timers?: LiveRefreshTimers;
}
export interface LiveRefresh {
    /** A frame arrived. Returns whether it counted (`isHint`). Without a frame, always counts. */
    hint: (frame?: unknown) => boolean;
    /** Read now, skipping the coalescing window (still one in flight + one queued). */
    refresh: () => void;
    /** Live = connected and the channel acknowledged. Becoming live reads at once. */
    setLive: (live: boolean) => void;
    /** Whether the document is hidden: pauses the poll timer. */
    setHidden: (hidden: boolean) => void;
    readonly live: boolean;
    readonly hidden: boolean;
    /** A read is in flight. */
    readonly reading: boolean;
    /** Consecutive failed reads (0 after a success). */
    readonly failures: number;
    /** Abort the read in flight, clear every timer; nothing reports after it. Idempotent. */
    dispose: () => void;
}
/**
 * The wait before the next poll after `failures` consecutive failures: the
 * base doubled per failure, capped at `maxFactor` (clamped to 1–5) times it.
 * A non-positive or non-finite base comes back unchanged.
 */
export declare function liveRefreshDelay(failures: number, baseMs: number, maxFactor?: number): number;
/** The coalesced "hint → re-read, else poll" loop. See the file header. */
export declare function createLiveRefresh<T>(o: LiveRefreshOptions<T>): LiveRefresh;
//# sourceMappingURL=liveRefresh.d.ts.map