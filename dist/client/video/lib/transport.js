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
 *  Returns null for absent/malformed/past-date inputs. */
function parseRetryAfter(headerValue) {
    if (!headerValue)
        return null;
    const trimmed = headerValue.trim();
    if (trimmed === '')
        return null;
    // Delta-seconds form
    if (/^\d+$/.test(trimmed)) {
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
async function whipPublish(opts) {
    const base = opts.baseUrl ?? '';
    let url = `${base}/api/channels/${encodeURIComponent(opts.channelArn)}/whip`;
    if (opts.participantId) {
        url += `?participantId=${encodeURIComponent(opts.participantId)}`;
    }
    const f = opts.fetchImpl ?? fetch;
    const r = await f(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/sdp',
            Authorization: `Bearer ${opts.authToken}`,
        },
        body: opts.offerSdp,
    });
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
    const r = await f(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/sdp',
            Authorization: `Bearer ${opts.authToken}`,
        },
        body: opts.offerSdp,
        redirect: 'follow',
    });
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