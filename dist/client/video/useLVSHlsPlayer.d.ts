export interface UseLVSHlsPlayerOptions {
    /** Channel ARN — the recording's source channel. Null = idle. */
    channelArn: string | null;
    /** Time window for the DVR playlist. Required — LVS defaults are
     *  `now - 1h` / `now` which is rarely what consumers want. */
    fromIso: string | null;
    toIso: string | null;
    /** Optional playback JWT for private channels. */
    playbackToken?: string | null;
    /** Override base URL (else pulled from LVSProvider). */
    baseUrl?: string;
}
export interface UseLVSHlsPlayerResult {
    /** Ready-to-use HLS playlist URL, or null if inputs are incomplete. */
    playlistUrl: string | null;
    /** Seconds until the playback token expires (Infinity if no exp claim,
     *  null if no token). Consumers use this to refresh before playback. */
    tokenExpiresInSec: number | null;
    /** True when inputs are present and a URL can be produced. */
    ready: boolean;
}
export declare function useLVSHlsPlayer(opts: UseLVSHlsPlayerOptions): UseLVSHlsPlayerResult;
//# sourceMappingURL=useLVSHlsPlayer.d.ts.map