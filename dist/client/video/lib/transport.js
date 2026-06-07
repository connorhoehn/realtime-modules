"use strict";
// Raw WHIP/WHEP transport — pure fetch wrappers around the LVS-compatible
// SFU endpoints. No React, no LVS-app concerns (no UIProvider, no
// localStorage). Auth is injected via a Bearer-token resolver so consumers
// own credential management.
//
// Lifted from /Users/connorhoehn/Projects/live-video-streaming/ui/src/lib/api.ts
// (whipPublish / whipTeardown / whepPublish / whepTeardown / fetchIceServers).
Object.defineProperty(exports, "__esModule", { value: true });
exports.LVSApiError = void 0;
exports.parseRetryAfter = parseRetryAfter;
exports.computeTooEarlyBackoffMs = computeTooEarlyBackoffMs;
exports.whipPublish = whipPublish;
exports.whipTeardown = whipTeardown;
exports.whepPublish = whepPublish;
exports.whepTeardown = whepTeardown;
exports.fetchIceServers = fetchIceServers;
class LVSApiError extends Error {
    status;
    url;
    /** Parsed `Retry-After` value in seconds, when the server sent one
     *  (typically on 503). Supports both delta-seconds and HTTP-date
     *  formats per RFC 7231 §7.1.3. `null` when absent or unparseable. */
    retryAfterSec;
    constructor(message, status, url, retryAfterSec = null) {
        super(message);
        this.name = 'LVSApiError';
        this.status = status;
        this.url = url;
        this.retryAfterSec = retryAfterSec;
    }
}
exports.LVSApiError = LVSApiError;
/** Parse a `Retry-After` header value into a delay in seconds. Accepts
 *  delta-seconds ("120") or HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT").
 *  Returns null for absent/malformed/past-date inputs.
 *
 *  Tolerates fractional delta-seconds ("0.5") for the SFU's 425-on-pipe-
 *  warmup path, where the server hints sub-second backoff. RFC 7231 only
 *  defines integer delta-seconds, but our SFU emits floats and the
 *  lvs-client SDK already parses them — keep behavior consistent. */
function parseRetryAfter(headerValue) {
    if (!headerValue)
        return null;
    const trimmed = headerValue.trim();
    if (trimmed === '')
        return null;
    // Delta-seconds form (integer or fractional)
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
        const n = Number(trimmed);
        return Number.isFinite(n) && n >= 0 ? n : null;
    }
    // HTTP-date form
    const date = Date.parse(trimmed);
    if (Number.isNaN(date))
        return null;
    const deltaSec = Math.ceil((date - Date.now()) / 1000);
    return deltaSec >= 0 ? deltaSec : null;
}
/** WHEP/WHIP 425 ("Too Early") retry budget. The SFU emits 425 while a
 *  cache-miss pod establishes its mesh-fanout pipe to the publisher pod
 *  — the answer becomes valid within a few hundred ms. Mirrors
 *  `~/Projects/live-video-streaming/packages/lvs-client/src/whep.js`. */
const TOO_EARLY_MAX_ATTEMPTS = 5;
const TOO_EARLY_DEADLINE_MS = 5_000;
const TOO_EARLY_MIN_BACKOFF_MS = 250;
const TOO_EARLY_MAX_BACKOFF_MS = 2_000;
/** Compute the next 425 backoff in ms. Uses the server's `Retry-After`
 *  when present, otherwise a jittered value in [250, 2000]. Exported
 *  for test injection — production callers should not call this. */
function computeTooEarlyBackoffMs(retryAfterSec, rand = Math.random) {
    if (retryAfterSec !== null && retryAfterSec > 0) {
        const fromHeader = retryAfterSec * 1000;
        return Math.max(TOO_EARLY_MIN_BACKOFF_MS, Math.min(TOO_EARLY_MAX_BACKOFF_MS, fromHeader));
    }
    // Jittered 250-2000ms when the server didn't pin a Retry-After
    const span = TOO_EARLY_MAX_BACKOFF_MS - TOO_EARLY_MIN_BACKOFF_MS;
    return TOO_EARLY_MIN_BACKOFF_MS + Math.floor(rand() * span);
}
function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Internal: POST an SDP offer with the 425 ("Too Early") retry loop.
 *  The SFU returns 425 when a cache-miss pod is still establishing its
 *  mesh-fanout pipe to the publisher pod — the answer becomes valid
 *  within a few hundred ms. Mirrors the lvs-client SDK pattern. All
 *  other non-2xx responses (including 4xx, 5xx, network errors) flow
 *  straight through to the caller's existing throw path. */
async function postSdpWith425Retry(url, body, authToken, f, flavor, log, deps, fetchInit = {}) {
    const sleep = deps.sleep ?? defaultSleep;
    const now = deps.now ?? Date.now;
    const rand = deps.rand ?? Math.random;
    const startedAt = now();
    let attempt = 0;
    let lastResponse = null;
    for (;;) {
        attempt += 1;
        const r = await f(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/sdp',
                Authorization: `Bearer ${authToken}`,
            },
            body,
            ...fetchInit,
        });
        if (r.status !== 425)
            return r;
        lastResponse = r;
        const retryAfter = parseRetryAfter(r.headers.get('Retry-After'));
        const elapsed = now() - startedAt;
        const atAttemptCap = attempt >= TOO_EARLY_MAX_ATTEMPTS;
        const atDeadline = elapsed >= TOO_EARLY_DEADLINE_MS;
        if (atAttemptCap || atDeadline) {
            if (log) {
                log(`[lvs:${flavor.toLowerCase()}] 425 retry budget exhausted `
                    + `(attempt=${attempt}, elapsed=${elapsed}ms, `
                    + `attemptCap=${atAttemptCap}, deadlineHit=${atDeadline})`);
            }
            return lastResponse;
        }
        const delayMs = computeTooEarlyBackoffMs(retryAfter, rand);
        if (log) {
            log(`[lvs:${flavor.toLowerCase()}] 425 Too Early — retry `
                + `attempt=${attempt}/${TOO_EARLY_MAX_ATTEMPTS} `
                + `delayMs=${delayMs} retryAfterSec=${retryAfter ?? 'none'} `
                + `elapsed=${elapsed}ms`);
        }
        // Drain the body so the connection can be reused. Best-effort.
        try {
            await r.text();
        }
        catch { /* ignore */ }
        await sleep(delayMs);
    }
}
async function whipPublish(opts) {
    const base = opts.baseUrl ?? '';
    let url = `${base}/api/channels/${encodeURIComponent(opts.channelArn)}/whip`;
    if (opts.participantId) {
        url += `?participantId=${encodeURIComponent(opts.participantId)}`;
    }
    const f = opts.fetchImpl ?? fetch;
    const r = await postSdpWith425Retry(url, opts.offerSdp, opts.authToken, f, 'WHIP', opts.log, opts.__tooEarlyDeps ?? {});
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new LVSApiError(`${r.status}${body ? ` — ${body.slice(0, 200)}` : ''}`, r.status, url, parseRetryAfter(r.headers.get('Retry-After')));
    }
    return {
        answerSdp: await r.text(),
        location: r.headers.get('Location'),
        sfuNode: r.headers.get('X-SFU-Node'),
    };
}
async function whipTeardown(resourceUrl, authToken, fetchImpl) {
    const f = fetchImpl ?? fetch;
    try {
        await f(resourceUrl, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${authToken}` },
            // `keepalive: true` lets the request survive page unload
            // (Cmd+W / nav-away / tab kill) up to ~5 s — without it the
            // browser cancels the in-flight fetch the moment the page
            // dies, the SFU never sees the DELETE, and the producer hangs
            // on until ICE-disconnect-grace (20 s) reaps it. Payload-size
            // limit is 64 KB; a no-body DELETE is well inside that.
            keepalive: true,
        });
    }
    catch { /* best-effort */ }
}
async function whepPublish(opts) {
    const base = opts.baseUrl ?? '';
    let url = `${base}/api/channels/${encodeURIComponent(opts.channelArn)}/whep`;
    const params = [];
    if (opts.participantId)
        params.push(`participantId=${encodeURIComponent(opts.participantId)}`);
    if (opts.excludeParticipantId)
        params.push(`excludeParticipantId=${encodeURIComponent(opts.excludeParticipantId)}`);
    if (params.length)
        url += `?${params.join('&')}`;
    const f = opts.fetchImpl ?? fetch;
    const r = await postSdpWith425Retry(url, opts.offerSdp, opts.authToken, f, 'WHEP', opts.log, opts.__tooEarlyDeps ?? {}, { redirect: 'follow' });
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new LVSApiError(`${r.status} ${r.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`, r.status, url, parseRetryAfter(r.headers.get('Retry-After')));
    }
    return {
        answerSdp: await r.text(),
        location: r.headers.get('Location'),
        sfuNode: r.headers.get('X-SFU-Node'),
    };
}
async function whepTeardown(resourceUrl, authToken, fetchImpl) {
    const f = fetchImpl ?? fetch;
    try {
        await f(resourceUrl, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${authToken}` },
            // Same rationale as whipTeardown — survive Cmd+W / tab kill so
            // the SFU releases the consumer transport immediately.
            keepalive: true,
        });
    }
    catch { /* best-effort */ }
}
/** Fetch ICE-server config from the SFU. Falls back to public STUN if
 *  the endpoint isn't reachable (matches LVS demo behavior). */
async function fetchIceServers(baseUrl, fetchImpl) {
    const base = baseUrl ?? '';
    const f = fetchImpl ?? fetch;
    try {
        const r = await f(`${base}/api/ice-servers`);
        if (r.ok) {
            const json = (await r.json());
            if (Array.isArray(json.iceServers) && json.iceServers.length > 0) {
                return json.iceServers;
            }
        }
    }
    catch { /* fall through to public STUN */ }
    return [{ urls: 'stun:stun.l.google.com:19302' }];
}
//# sourceMappingURL=transport.js.map