// realtime-modules/src/client/liveRefresh.ts
//
// "A frame is a hint; the record is the truth" (0.145.0), framework-free.
//
// Apps that render a durable record (a run, a project) over a socket kept
// hand-rolling the same two things: a frame about the record re-reads it,
// coalesced; and with the socket down (or the channel refused) a poll does
// instead. This is that loop, ported from the aws-agentcore portal's
// flowRunFollower (where it is tested against the BFF gateway):
//
//   live (the host says so: socket connected AND the channel acknowledged)
//     - a hint re-reads the record, coalesced over `coalesceMs`, with at most
//       one read in flight and one queued behind it;
//     - becoming live re-reads it at once (catch-up: frames sent while the
//       socket was down are gone, the record is not);
//     - a slow safety read every `livePollMs` covers a lost frame (0: off).
//   not live
//     - a read every `pollMs` (0: off).
//   both
//     - a failed read backs the next poll off: doubled per consecutive
//       failure, at most `maxBackoff` (≤ 5) times the cadence; the first
//       success resets it. With the cadence off, a failure retries on
//       `pollMs`;
//     - while hidden the poll timer is paused; becoming visible reads at once
//       if a poll came due meanwhile, else resumes the remaining wait. Hints
//       still read while hidden;
//     - dispose() aborts the read in flight and clears every timer.
//
// React binding: useLiveRefresh (./useLiveRefresh).

import { isDocumentHidden } from './useDocumentHidden';

export const DEFAULT_LIVE_REFRESH_POLL_MS = 5_000;
export const DEFAULT_LIVE_REFRESH_LIVE_POLL_MS = 30_000;
/** The backoff ceiling, as a multiple of the cadence. */
export const MAX_LIVE_REFRESH_BACKOFF = 5;

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
export function liveRefreshDelay(failures: number, baseMs: number, maxFactor = MAX_LIVE_REFRESH_BACKOFF): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return baseMs;
  if (!Number.isFinite(failures) || failures <= 0) return baseMs;
  const cap = Math.min(MAX_LIVE_REFRESH_BACKOFF, Math.max(1, Number.isFinite(maxFactor) ? maxFactor : MAX_LIVE_REFRESH_BACKOFF));
  return baseMs * Math.min(2 ** failures, cap);
}

const nonNegative = (v: number | undefined, fallback: number) =>
  v === undefined || !Number.isFinite(v) ? fallback : Math.max(0, v);

/** The coalesced "hint → re-read, else poll" loop. See the file header. */
export function createLiveRefresh<T>(o: LiveRefreshOptions<T>): LiveRefresh {
  const setTimer = o.timers?.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.timers?.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = o.now ?? (() => Date.now());
  const coalesceMs = nonNegative(o.coalesceMs, 0);
  const livePollMs = nonNegative(o.livePollMs, DEFAULT_LIVE_REFRESH_LIVE_POLL_MS);
  const pollMs = nonNegative(o.pollMs, DEFAULT_LIVE_REFRESH_POLL_MS);
  const maxBackoff = o.maxBackoff ?? MAX_LIVE_REFRESH_BACKOFF;

  let disposed = false;
  let live = o.live === true;
  let hidden = o.hidden ?? isDocumentHidden();
  let failures = 0;
  let inFlight: AbortController | null = null;
  let queued = false;
  let pollTimer: unknown = null;
  let coalesceTimer: unknown = null;
  /** When the next poll is due; null when none is scheduled. Kept while hidden. */
  let dueAt: number | null = null;

  const clearPoll = () => {
    if (pollTimer !== null) { clearTimer(pollTimer); pollTimer = null; }
  };
  const clearCoalesce = () => {
    if (coalesceTimer !== null) { clearTimer(coalesceTimer); coalesceTimer = null; }
  };
  const armPoll = (wait: number) => {
    clearPoll();
    pollTimer = setTimer(() => { pollTimer = null; dueAt = null; read(); }, Math.max(0, wait));
  };

  const schedule = () => {
    clearPoll();
    dueAt = null;
    if (disposed || inFlight) return;
    let base = live ? livePollMs : pollMs;
    // A failure with the cadence off still retries, on the offline cadence.
    if (base <= 0 && failures > 0) base = pollMs;
    if (base <= 0) return;
    const wait = liveRefreshDelay(failures, base, maxBackoff);
    dueAt = now() + wait;
    if (!hidden) armPoll(wait);
  };

  const read = () => {
    if (disposed) return;
    if (inFlight) { queued = true; return; }
    clearPoll();
    clearCoalesce();
    dueAt = null;
    const ctl = new AbortController();
    inFlight = ctl;
    let pending: Promise<T>;
    try { pending = o.read(ctl.signal); } catch (err) { pending = Promise.reject(err); }
    void Promise.resolve(pending).then(
      (value) => {
        if (disposed || ctl.signal.aborted) return;
        failures = 0;
        o.onData?.(value);
      },
      (err: unknown) => {
        if (disposed || ctl.signal.aborted) return;
        failures += 1;
        o.onError?.(err);
      },
    ).finally(() => {
      if (inFlight !== ctl) return;
      inFlight = null;
      if (disposed) return;
      if (queued) { queued = false; read(); return; }
      schedule();
    });
  };

  const hint = (...args: [frame?: unknown]): boolean => {
    if (disposed) return false;
    if (args.length > 0 && o.isHint && !o.isHint(args[0])) return false;
    if (coalesceMs <= 0) { read(); return true; }
    if (coalesceTimer === null) {
      coalesceTimer = setTimer(() => { coalesceTimer = null; read(); }, coalesceMs);
    }
    return true;
  };

  if (o.immediate !== false) read();
  else schedule();

  return {
    hint,
    refresh: () => read(),
    setLive(next: boolean) {
      if (disposed || next === live) return;
      live = next;
      if (live) read();            // catch up: what was sent while down is only in the record
      else if (!inFlight) schedule(); // back to the offline cadence now, not after the live wait
    },
    setHidden(next: boolean) {
      if (disposed || next === hidden) return;
      hidden = next;
      if (hidden) { clearPoll(); return; }
      if (dueAt === null || inFlight) return;
      const wait = dueAt - now();
      if (wait <= 0) { dueAt = null; read(); } else armPoll(wait);
    },
    get live() { return live; },
    get hidden() { return hidden; },
    get reading() { return inFlight !== null; },
    get failures() { return failures; },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearPoll();
      clearCoalesce();
      dueAt = null;
      queued = false;
      inFlight?.abort();
      inFlight = null;
    },
  };
}
