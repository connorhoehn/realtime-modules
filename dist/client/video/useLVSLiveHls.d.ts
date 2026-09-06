export interface UseLVSLiveHlsOptions {
    /** Channel ARN to watch. Null = idle, which is the pre-broadcast state. */
    channelArn: string | null;
    /**
     * Ask for the ABR master playlist rather than a single rendition.
     *
     * Default true: an audience is on every network there is, and the whole
     * reason to choose HLS is that the player can drop a rung instead of
     * stalling. Set false to pin one rendition (a kiosk on a known link).
     */
    abr?: boolean;
    /** Playback JWT for private channels. Public channels need none. */
    playbackToken?: string | null;
    /** Override base URL (else pulled from LVSProvider). */
    baseUrl?: string;
}
export interface UseLVSLiveHlsResult {
    /** Ready-to-play playlist URL, or null when inputs are incomplete. */
    playlistUrl: string | null;
    /**
     * Seconds until the playback token expires — Infinity when the token has no
     * exp claim, null when there is no token.
     *
     * Live playback outlives a token far more often than VOD does: a viewer
     * leaves a broadcast open for an hour. Refresh BEFORE this reaches zero, or
     * the stream dies mid-segment with a network error that looks like a
     * broken stream rather than an expired credential.
     */
    tokenExpiresInSec: number | null;
    /** True when a URL could be produced. */
    ready: boolean;
}
export declare function useLVSLiveHls(opts: UseLVSLiveHlsOptions): UseLVSLiveHlsResult;
//# sourceMappingURL=useLVSLiveHls.d.ts.map