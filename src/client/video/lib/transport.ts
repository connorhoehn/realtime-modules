// Raw WHIP/WHEP transport — pure fetch wrappers around the LVS-compatible
// SFU endpoints. No React, no LVS-app concerns (no UIProvider, no
// localStorage). Auth is injected via a Bearer-token resolver so consumers
// own credential management.
//
// Lifted from /Users/connorhoehn/Projects/live-video-streaming/ui/src/lib/api.ts
// (whipPublish / whipTeardown / whepPublish / whepTeardown / fetchIceServers).

export class LVSApiError extends Error {
  status: number;
  url: string;
  /** Parsed `Retry-After` value in seconds, when the server sent one
   *  (typically on 503). Supports both delta-seconds and HTTP-date
   *  formats per RFC 7231 §7.1.3. `null` when absent or unparseable. */
  retryAfterSec: number | null;
  constructor(
    message: string,
    status: number,
    url: string,
    retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = 'LVSApiError';
    this.status = status;
    this.url = url;
    this.retryAfterSec = retryAfterSec;
  }
}

/** Parse a `Retry-After` header value into a delay in seconds. Accepts
 *  delta-seconds ("120") or HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT").
 *  Returns null for absent/malformed/past-date inputs. */
export function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (trimmed === '') return null;
  // Delta-seconds form
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  // HTTP-date form
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const deltaSec = Math.ceil((date - Date.now()) / 1000);
  return deltaSec >= 0 ? deltaSec : null;
}

export interface WhipPublishOptions {
  /** Channel ARN (e.g. `arn:local:ivs:channel/<uuid>`). Used to build
   *  the WHIP URL: `${baseUrl}/api/channels/:arn/whip`. */
  channelArn: string;
  /** SDP offer body. POST'd as `Content-Type: application/sdp`. */
  offerSdp: string;
  /** Bearer token (stream key OR participant JWT). The SFU validates. */
  authToken: string;
  /** Per-tab participantId, appended as ?participantId=X so consumers
   *  of WHEP can disambiguate this publisher's producers from others'. */
  participantId?: string;
  /** Base URL of the SFU. Defaults to same-origin. */
  baseUrl?: string;
  /** Optional fetch override for tests / SSR. */
  fetchImpl?: typeof fetch;
}

export interface WhipPublishResult {
  answerSdp: string;
  /** WHIP resource URL from the Location header. Pass to whipTeardown. */
  location: string | null;
  /** Which SFU pod served the request, from X-SFU-Node header. Useful
   *  for multi-pod telemetry. Null if header missing (single-pod). */
  sfuNode: string | null;
}

export async function whipPublish(opts: WhipPublishOptions): Promise<WhipPublishResult> {
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
    throw new LVSApiError(
      `${r.status}${body ? ` — ${body.slice(0, 200)}` : ''}`,
      r.status,
      url,
      parseRetryAfter(r.headers.get('Retry-After')),
    );
  }
  return {
    answerSdp: await r.text(),
    location: r.headers.get('Location'),
    sfuNode: r.headers.get('X-SFU-Node'),
  };
}

export async function whipTeardown(resourceUrl: string, authToken: string, fetchImpl?: typeof fetch): Promise<void> {
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
  } catch { /* best-effort */ }
}

export interface WhepPublishOptions {
  /** Channel ARN. Used to build `${baseUrl}/api/channels/:arn/whep`. */
  channelArn: string;
  /** SDP offer body — typically two `recvonly` transceivers. */
  offerSdp: string;
  /** Bearer token (playback JWT or public stream identifier). */
  authToken: string;
  /** When set, the SFU filters out producers belonging to this
   *  participantId so the WHEP answer never includes the caller's own
   *  published tracks. Required for hangouts (else self-echo). */
  excludeParticipantId?: string;
  /** When set, the SFU returns ONLY the named publisher's producers.
   *  Used by the parallel screen-share WHEP — without this the SFU
   *  picks the first matching producer (typically the publisher's
   *  camera) instead of the targeted `${pid}:screen` producer. */
  participantId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface WhepPublishResult {
  answerSdp: string;
  location: string | null;
  sfuNode: string | null;
}

export async function whepPublish(opts: WhepPublishOptions): Promise<WhepPublishResult> {
  const base = opts.baseUrl ?? '';
  let url = `${base}/api/channels/${encodeURIComponent(opts.channelArn)}/whep`;
  const params: string[] = [];
  if (opts.participantId) params.push(`participantId=${encodeURIComponent(opts.participantId)}`);
  if (opts.excludeParticipantId) params.push(`excludeParticipantId=${encodeURIComponent(opts.excludeParticipantId)}`);
  if (params.length) url += `?${params.join('&')}`;
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
    throw new LVSApiError(
      `${r.status} ${r.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
      r.status,
      url,
      parseRetryAfter(r.headers.get('Retry-After')),
    );
  }
  return {
    answerSdp: await r.text(),
    location: r.headers.get('Location'),
    sfuNode: r.headers.get('X-SFU-Node'),
  };
}

export async function whepTeardown(resourceUrl: string, authToken: string, fetchImpl?: typeof fetch): Promise<void> {
  const f = fetchImpl ?? fetch;
  try {
    await f(resourceUrl, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
      // Same rationale as whipTeardown — survive Cmd+W / tab kill so
      // the SFU releases the consumer transport immediately.
      keepalive: true,
    });
  } catch { /* best-effort */ }
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Fetch ICE-server config from the SFU. Falls back to public STUN if
 *  the endpoint isn't reachable (matches LVS demo behavior). */
export async function fetchIceServers(baseUrl?: string, fetchImpl?: typeof fetch): Promise<IceServerConfig[]> {
  const base = baseUrl ?? '';
  const f = fetchImpl ?? fetch;
  try {
    const r = await f(`${base}/api/ice-servers`);
    if (r.ok) {
      const json = (await r.json()) as { iceServers?: IceServerConfig[] };
      if (Array.isArray(json.iceServers) && json.iceServers.length > 0) {
        return json.iceServers;
      }
    }
  } catch { /* fall through to public STUN */ }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}
