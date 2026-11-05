"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_LIVE_REFRESH_BACKOFF = exports.DEFAULT_LIVE_REFRESH_LIVE_POLL_MS = exports.DEFAULT_LIVE_REFRESH_POLL_MS = void 0;
exports.liveRefreshDelay = liveRefreshDelay;
exports.createLiveRefresh = createLiveRefresh;
const useDocumentHidden_1 = require("./useDocumentHidden");
exports.DEFAULT_LIVE_REFRESH_POLL_MS = 5_000;
exports.DEFAULT_LIVE_REFRESH_LIVE_POLL_MS = 30_000;
/** The backoff ceiling, as a multiple of the cadence. */
exports.MAX_LIVE_REFRESH_BACKOFF = 5;
/**
 * The wait before the next poll after `failures` consecutive failures: the
 * base doubled per failure, capped at `maxFactor` (clamped to 1–5) times it.
 * A non-positive or non-finite base comes back unchanged.
 */
function liveRefreshDelay(failures, baseMs, maxFactor = exports.MAX_LIVE_REFRESH_BACKOFF) {
    if (!Number.isFinite(baseMs) || baseMs <= 0)
        return baseMs;
    if (!Number.isFinite(failures) || failures <= 0)
        return baseMs;
    const cap = Math.min(exports.MAX_LIVE_REFRESH_BACKOFF, Math.max(1, Number.isFinite(maxFactor) ? maxFactor : exports.MAX_LIVE_REFRESH_BACKOFF));
    return baseMs * Math.min(2 ** failures, cap);
}
const nonNegative = (v, fallback) => v === undefined || !Number.isFinite(v) ? fallback : Math.max(0, v);
/** The coalesced "hint → re-read, else poll" loop. See the file header. */
function createLiveRefresh(o) {
    const setTimer = o.timers?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = o.timers?.clearTimeout ?? ((h) => clearTimeout(h));
    const now = o.now ?? (() => Date.now());
    const coalesceMs = nonNegative(o.coalesceMs, 0);
    const livePollMs = nonNegative(o.livePollMs, exports.DEFAULT_LIVE_REFRESH_LIVE_POLL_MS);
    const pollMs = nonNegative(o.pollMs, exports.DEFAULT_LIVE_REFRESH_POLL_MS);
    const maxBackoff = o.maxBackoff ?? exports.MAX_LIVE_REFRESH_BACKOFF;
    let disposed = false;
    let live = o.live === true;
    let hidden = o.hidden ?? (0, useDocumentHidden_1.isDocumentHidden)();
    let failures = 0;
    let inFlight = null;
    let queued = false;
    let pollTimer = null;
    let coalesceTimer = null;
    /** When the next poll is due; null when none is scheduled. Kept while hidden. */
    let dueAt = null;
    const clearPoll = () => {
        if (pollTimer !== null) {
            clearTimer(pollTimer);
            pollTimer = null;
        }
    };
    const clearCoalesce = () => {
        if (coalesceTimer !== null) {
            clearTimer(coalesceTimer);
            coalesceTimer = null;
        }
    };
    const armPoll = (wait) => {
        clearPoll();
        pollTimer = setTimer(() => { pollTimer = null; dueAt = null; read(); }, Math.max(0, wait));
    };
    const schedule = () => {
        clearPoll();
        dueAt = null;
        if (disposed || inFlight)
            return;
        let base = live ? livePollMs : pollMs;
        // A failure with the cadence off still retries, on the offline cadence.
        if (base <= 0 && failures > 0)
            base = pollMs;
        if (base <= 0)
            return;
        const wait = liveRefreshDelay(failures, base, maxBackoff);
        dueAt = now() + wait;
        if (!hidden)
            armPoll(wait);
    };
    const read = () => {
        if (disposed)
            return;
        if (inFlight) {
            queued = true;
            return;
        }
        clearPoll();
        clearCoalesce();
        dueAt = null;
        const ctl = new AbortController();
        inFlight = ctl;
        let pending;
        try {
            pending = o.read(ctl.signal);
        }
        catch (err) {
            pending = Promise.reject(err);
        }
        void Promise.resolve(pending).then((value) => {
            if (disposed || ctl.signal.aborted)
                return;
            failures = 0;
            o.onData?.(value);
        }, (err) => {
            if (disposed || ctl.signal.aborted)
                return;
            failures += 1;
            o.onError?.(err);
        }).finally(() => {
            if (inFlight !== ctl)
                return;
            inFlight = null;
            if (disposed)
                return;
            if (queued) {
                queued = false;
                read();
                return;
            }
            schedule();
        });
    };
    const hint = (...args) => {
        if (disposed)
            return false;
        if (args.length > 0 && o.isHint && !o.isHint(args[0]))
            return false;
        if (coalesceMs <= 0) {
            read();
            return true;
        }
        if (coalesceTimer === null) {
            coalesceTimer = setTimer(() => { coalesceTimer = null; read(); }, coalesceMs);
        }
        return true;
    };
    if (o.immediate !== false)
        read();
    else
        schedule();
    return {
        hint,
        refresh: () => read(),
        setLive(next) {
            if (disposed || next === live)
                return;
            live = next;
            if (live)
                read(); // catch up: what was sent while down is only in the record
            else if (!inFlight)
                schedule(); // back to the offline cadence now, not after the live wait
        },
        setHidden(next) {
            if (disposed || next === hidden)
                return;
            hidden = next;
            if (hidden) {
                clearPoll();
                return;
            }
            if (dueAt === null || inFlight)
                return;
            const wait = dueAt - now();
            if (wait <= 0) {
                dueAt = null;
                read();
            }
            else
                armPoll(wait);
        },
        get live() { return live; },
        get hidden() { return hidden; },
        get reading() { return inFlight !== null; },
        get failures() { return failures; },
        dispose() {
            if (disposed)
                return;
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
//# sourceMappingURL=liveRefresh.js.map