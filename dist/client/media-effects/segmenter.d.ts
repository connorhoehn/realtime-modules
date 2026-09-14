/**
 * Alpha-shaping curve applied to raw per-pixel person probabilities.
 * A small threshold curve sharpens the edge around 0.5 so low-confidence
 * spray doesn't leak through, but keeps feathering for a natural silhouette:
 *   curve(p) = clamp(1.8 * p - 0.4, 0, 1)  → 0 below 0.22, 1 above 0.78
 * Exported as a pure function so the curve is unit-testable without canvas.
 */
export declare function shapeConfidence(p: number): number;
/**
 * Module-level warmup: kick the WASM + model download without needing a
 * PersonSegmenter instance (the app calls this when the effects UI opens,
 * before any effect is selected, so first selection doesn't freeze on
 * model init). Safe to call repeatedly — the loader is a keyed singleton.
 * SSR-safe: no-op without window/document.
 */
export declare function warmupSegmenter(): Promise<void>;
export declare class PersonSegmenter {
    private segmenter;
    /** In-flight acquire, so a frame loop asking every frame starts one load. */
    private loading;
    /** Bumped by close(); an acquire that lands from an older generation is
     *  released, never installed. */
    private generation;
    private maskCanvas;
    private maskCtx;
    private imageData;
    warmup(): Promise<void>;
    /**
     * Run segmentation on the current video frame. Returns a canvas whose
     * alpha encodes per-pixel person probability. Null until model loads.
     */
    segment(video: HTMLVideoElement, timestampMs: number): HTMLCanvasElement | null;
    private ensureLoading;
    /** Releases THIS segmenter's graph only. Other PersonSegmenters — and the
     *  warm slot — are untouched. Safe to segment() again afterwards: it
     *  acquires a fresh instance. */
    close(): void;
}
//# sourceMappingURL=segmenter.d.ts.map