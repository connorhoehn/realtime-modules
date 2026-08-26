export interface CaptionLine {
    id: string;
    speakerId: string;
    speakerName?: string;
    text: string;
    at: string;
    interim?: boolean;
}
export interface UseLiveCaptionsOptions {
    /** Scope captions to this call. Caption envelopes for other calls
     *  in the same WS are ignored. Optional when `channel` is given. */
    callId?: string | null;
    /**
     * Scope captions to a WS channel instead of a call.
     *
     * The live-captions sidecar is a generic speech-to-text service — its
     * `X-Channel-Arn` is free-form and the gateway relay fans every
     * `captions:*` publish out to `captions:<sha1(key)[:24]>`. Ambient
     * (non-call) capture therefore produces caption frames with no `callId`
     * at all, and the call-scoped filter below would drop every one of them.
     * Pass the channel and lines are matched on the frame's `channel` field.
     *
     * When both are given, `channel` wins.
     */
    channel?: string | null;
    /** Subscribe to the gateway WS. Returns an unsubscribe fn. */
    subscribe: (handler: (msg: unknown) => void) => () => void;
    /** Maximum lines retained in memory. Default 50. */
    maxLines?: number;
}
export declare function useLiveCaptions({ callId, channel, subscribe, maxLines, }: UseLiveCaptionsOptions): CaptionLine[];
//# sourceMappingURL=useLiveCaptions.d.ts.map