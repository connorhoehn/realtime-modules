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
     *  in the same WS are ignored. */
    callId: string | null;
    /** Subscribe to the gateway WS. Returns an unsubscribe fn. */
    subscribe: (handler: (msg: unknown) => void) => () => void;
    /** Maximum lines retained in memory. Default 50. */
    maxLines?: number;
}
export declare function useLiveCaptions({ callId, subscribe, maxLines, }: UseLiveCaptionsOptions): CaptionLine[];
//# sourceMappingURL=useLiveCaptions.d.ts.map