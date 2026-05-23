export declare class LVSApiError extends Error {
    status: number;
    url: string;
    constructor(message: string, status: number, url: string);
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
    baseUrl?: string;
    fetchImpl?: typeof fetch;
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
//# sourceMappingURL=transport.d.ts.map