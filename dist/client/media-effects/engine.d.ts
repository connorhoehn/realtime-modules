import { PersonSegmenter } from './segmenter';
import { FaceTracker } from './faceLandmarker';
export type BackgroundMode = 'none' | 'blur' | 'image';
export type OutputChangeListener = (track: MediaStreamTrack | null) => void;
export type WarmupTarget = 'segmentation' | 'faces' | 'all';
/**
 * Temporal smoothing weight for the segmentation mask. Each fresh mask is
 * composited into maskSmoothCanvas at this alpha over the previous smoothed
 * contents — an exponential moving average that suppresses the per-frame
 * contour flicker users reported as "choppy". Range (0, 1]: higher = more
 * responsive, lower = smoother.
 */
export declare const MASK_EMA_ALPHA = 0.45;
/**
 * Feather radius (px) applied when the smoothed mask cuts out the person
 * (`destination-in` draw). Softens the silhouette edge so it isn't
 * hard/blocky against the blurred or replaced background.
 */
export declare const MASK_FEATHER_PX = 3;
/**
 * Run person segmentation every Nth drawn frame; the in-between frames
 * reuse the smoothed mask (the EMA makes the reuse invisible). Segmentation
 * is the dominant per-frame CPU cost, and halving its rate removes most of
 * the jitter. The FaceLandmarker still runs every frame — sprite tracking
 * must not lag the face.
 */
export declare const SEGMENT_FRAME_INTERVAL = 2;
export declare class MediaEffectsEngine {
    private source;
    private filterId;
    private backgroundMode;
    private backgroundImageUrl;
    private backgroundImage;
    private faceSpriteId;
    private pipeline;
    private listeners;
    private disposed;
    private handleSourceEnded;
    getFilterId(): string;
    getBackgroundMode(): BackgroundMode;
    getBackgroundImageUrl(): string | null;
    getFaceSpriteId(): string | null;
    getSource(): MediaStreamTrack | null;
    /** Active = at least one effect is on. Drives pipeline existence. */
    isActive(): boolean;
    /** Canvas track while active, raw source track while inactive. */
    getOutputTrack(): MediaStreamTrack | null;
    /** Fired whenever output identity changes (activation, deactivation,
     *  setSource, source ended). Returns unsubscribe. */
    onOutputChange(cb: OutputChangeListener): () => void;
    setSource(track: MediaStreamTrack | null): void;
    setFilter(id: string): void;
    setBackgroundMode(mode: BackgroundMode): void;
    setBackgroundImageUrl(url: string | null): void;
    setFaceSpriteId(id: string | null): void;
    /** Full teardown. Never stops the source track (caller owns it). */
    dispose(): void;
    private syncPipeline;
    private buildPipeline;
    private teardownPipeline;
    private drawFrame;
    /**
     * Composite a fresh segmentation mask into the EMA accumulator.
     *
     * First mask after build/resize seeds the canvas with a full-alpha copy
     * so effects don't fade in from nothing. After that each fresh mask is
     * blended at MASK_EMA_ALPHA: previous contents are first faded by
     * (1 - alpha) via a destination-out fill, then the new mask is drawn
     * source-over at alpha. The pre-fade matters — a bare source-over at
     * partial alpha can only ever *raise* per-pixel alpha, which would leave
     * permanent ghost silhouettes wherever the person used to be.
     */
    private blendMaskIntoSmooth;
    /**
     * Preload MediaPipe models before any effect is selected — call when the
     * effects UI opens so the first toggle doesn't freeze on model init.
     * Fire-and-forget, safe to call repeatedly (keyed singleton loaders),
     * SSR-safe (no-op without window/document), and works before any
     * pipeline exists (module-level loaders, not pipeline instances).
     */
    warmup(target?: WarmupTarget): void;
    private emitIfChanged;
    protected createVideoElement(track: MediaStreamTrack): HTMLVideoElement;
    protected createCanvas(width: number, height: number): HTMLCanvasElement;
    protected captureCanvasStream(canvas: HTMLCanvasElement): MediaStream | null;
    protected createSegmenter(): PersonSegmenter;
    /** Segmentation pacing divisor; overridable in tests. */
    protected segmentFrameInterval(): number;
    /** Module-level segmenter loader trigger; overridable in tests. */
    protected warmupSegmentation(): Promise<void>;
    /** Module-level face-landmarker loader trigger; overridable in tests. */
    protected warmupFaces(): Promise<void>;
    protected createFaceTracker(): FaceTracker;
    protected loadBackgroundImage(url: string, onLoad: (img: HTMLImageElement) => void): void;
    protected requestFrame(cb: FrameRequestCallback): number;
    protected cancelFrame(id: number): void;
    protected now(): number;
}
//# sourceMappingURL=engine.d.ts.map