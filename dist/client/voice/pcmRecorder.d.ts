export interface PcmChunk {
    /** s16le mono bytes at TARGET_SAMPLE_RATE, ready to POST. */
    bytes: Uint8Array;
    /** Duration this chunk represents. */
    durationMs: number;
    /** RMS in s16 amplitude units. */
    rms: number;
    /** Whether the client's gate scored this chunk as speech. */
    isSpeech: boolean;
}
export interface PcmRecorderOptions {
    /** Audio per POST. 200 ms matches what the call-path tap sends. */
    chunkMs?: number;
    /** RMS gate, in s16 amplitude units. Mirrors the sidecar's LIVE_SILENCE_RMS. */
    silenceRms?: number;
    /** Called for every chunk. Must not throw — it is invoked from an audio callback. */
    onChunk: (chunk: PcmChunk) => void;
    /** Fatal capture error (permission denied, no device, worklet unavailable). */
    onError?: (err: Error) => void;
}
/** True when this browser can do ambient capture at all. */
export declare function isVoiceCaptureSupported(): boolean;
export declare class PcmRecorder {
    private stream;
    private ctx;
    private node;
    private source;
    private workletUrl;
    private readonly opts;
    constructor(opts: PcmRecorderOptions);
    /** True only while a real MediaStreamTrack is live. Drives the UI indicator. */
    get micActive(): boolean;
    start(): Promise<void>;
    private emit;
    /**
     * Release everything. Idempotent, never throws, and safe to call from a
     * cleanup path — the track MUST come down even if teardown of the graph
     * fails partway.
     */
    stop(): void;
}
//# sourceMappingURL=pcmRecorder.d.ts.map