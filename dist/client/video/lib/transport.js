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
exports.whipPublish = whipPublish;
exports.whipTeardown = whipTeardown;
exports.whepPublish = whepPublish;
exports.whepTeardown = whepTeardown;
exports.fetchIceServers = fetchIceServers;
class LVSApiError extends Error {
    status;
    url;
    constructor(message, status, url) {
        super(message);
        this.name = 'LVSApiError';
        this.status = status;
        this.url = url;
    }
}
exports.LVSApiError = LVSApiError;
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
        throw new LVSApiError(`${r.status}${body ? ` — ${body.slice(0, 200)}` : ''}`, r.status, url);
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
        });
    }
    catch { /* best-effort */ }
}
async function whepPublish(opts) {
    const base = opts.baseUrl ?? '';
    let url = `${base}/api/channels/${encodeURIComponent(opts.channelArn)}/whep`;
    if (opts.excludeParticipantId) {
        url += `?excludeParticipantId=${encodeURIComponent(opts.excludeParticipantId)}`;
    }
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
        throw new LVSApiError(`${r.status} ${r.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`, r.status, url);
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