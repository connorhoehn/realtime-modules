export interface UseLVSViewerCountOptions {
    /** Channel to count. Null is idle — no request is made. */
    channelArn: string | null;
    /** How often to re-ask, in ms. Default 15s. */
    intervalMs?: number;
    /** Override base URL (else pulled from LVSProvider). */
    baseUrl?: string;
    /** Playback JWT for private channels. */
    playbackToken?: string | null;
}
export interface UseLVSViewerCountResult {
    /**
     * Concurrent viewers, or null when it is not known.
     *
     * Null and 0 are DIFFERENT and callers must not collapse them: 0 is "nobody
     * is watching", null is "we have not been told". Rendering an unknown count
     * as `0 watching` invents a fact, and on a stream that is working it is the
     * most discouraging possible thing to show the person presenting.
     */
    viewerCount: number | null;
    /** Last failure, or null. Never thrown — a counter must not take a page down. */
    error: Error | null;
}
export declare function useLVSViewerCount({ channelArn, intervalMs, baseUrl: baseUrlOpt, playbackToken, }: UseLVSViewerCountOptions): UseLVSViewerCountResult;
//# sourceMappingURL=useLVSViewerCount.d.ts.map