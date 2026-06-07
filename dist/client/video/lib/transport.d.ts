export declare class LVSApiError extends Error {
    status: number;
    url: string;
    /** Parsed `Retry-After` value in seconds, when the server sent one
     *  (typically on 503). Supports both delta-seconds and HTTP-date
     *  formats per RFC 7231 §7.1.3. `null` when absent or unparseable. */
    retryAfterSec: number | null;
    constructor(message: string, status: number, url: string, retryAfterSec?: number | null);
}
/** Parse a `Retry-After` header value into a delay in seconds. Accepts
 *  delta-seconds ("120") or HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT").
 *  Returns null for absent/malformed/past-date inputs.
 *
 *  Tolerates fractional delta-seconds ("0.5") for the SFU's 425-on-pipe-
 *  warmup path, where the server hints sub-second backoff. RFC 7231 only
 *  defines integer delta-seconds, but our SFU emits floats and the
 *  lvs-client SDK already parses them — keep behavior consistent. */
export declare function parseRetryAfter(headerValue: string | null): number | null;
/** Compute the next 425 backoff in ms. Uses the server's `Retry-After`
 *  when present, otherwise a jittered value in [250, 2000]. Exported
 *  for test injection — production callers should not call this. */
export declare function computeTooEarlyBackoffMs(retryAfterSec: number | null, rand?: () => number): number;
/** Minimal debug-log hook for the 425 retry path. Kept local so
 *  transport.ts stays React-free — consumers pass through their own
 *  logger from LVSProvider / useLVS* hooks if they want observability. */
export type TransportLog = (msg: string) => void;
interface TooEarlyRetryDeps {
    log?: TransportLog;
    /** Override for tests: lets the suite advance fake timers without
     *  actually sleeping. Default uses real setTimeout. */
    sleep?: (ms: number) => Promise<void>;
    /** Override for tests: deterministic jitter. */
    rand?: () => number;
    /** Override for tests: deterministic deadline clock. */
    now?: () => number;
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
    /** Optional debug logger — emits one line per 425 retry attempt so
     *  the SFU's mesh-fanout-filter rollout is observable from devtools.
     *  Silent by default. */
    log?: TransportLog;
    /** Test-only sleep/random/clock overrides for the 425 retry loop.
     *  Not part of the public API surface; useLVS* hooks never pass these. */
    __tooEarlyDeps?: TooEarlyRetryDeps;
}
export interface WhipPublishResult {
    answerSdp: string;
    /** WHIP resource URL from the Location header. Pass to whipTeardown. */
    location: string | null;
    /** Which SFU pod served the request, from X-SFU-Node header. Useful
     *  for multi-pod telemetry. Null if header missing (single-pod). */
    sfuNode: string | null;
}
export declare function whipPublish(opts: WhipPublishOptions): Promise<WhipPublishResult>;
export declare function whipTeardown(resourceUrl: string, authToken: string, fetchImpl?: typeof fetch): Promise<void>;
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
    /** Optional debug logger — emits one line per 425 retry attempt so
     *  the SFU's mesh-fanout-filter rollout is observable from devtools.
     *  Silent by default. */
    log?: TransportLog;
    /** Test-only sleep/random/clock overrides for the 425 retry loop.
     *  Not part of the public API surface; useLVS* hooks never pass these. */
    __tooEarlyDeps?: TooEarlyRetryDeps;
}
export interface WhepPublishResult {
    answerSdp: string;
    location: string | null;
    sfuNode: string | null;
}
export declare function whepPublish(opts: WhepPublishOptions): Promise<WhepPublishResult>;
export declare function whepTeardown(resourceUrl: string, authToken: string, fetchImpl?: typeof fetch): Promise<void>;
export interface IceServerConfig {
    urls: string | string[];
    username?: string;
    credential?: string;
}
/** Fetch ICE-server config from the SFU. Falls back to public STUN if
 *  the endpoint isn't reachable (matches LVS demo behavior). */
export declare function fetchIceServers(baseUrl?: string, fetchImpl?: typeof fetch): Promise<IceServerConfig[]>;
export {};
//# sourceMappingURL=transport.d.ts.map