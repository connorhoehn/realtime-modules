import { PersonSegmenter } from './segmenter';
import { FaceTracker } from './faceLandmarker';
export type BackgroundMode = 'none' | 'blur' | 'image';
export type OutputChangeListener = (track: MediaStreamTrack | null) => void;
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
    private emitIfChanged;
    protected createVideoElement(track: MediaStreamTrack): HTMLVideoElement;
    protected createCanvas(width: number, height: number): HTMLCanvasElement;
    protected captureCanvasStream(canvas: HTMLCanvasElement): MediaStream | null;
    protected createSegmenter(): PersonSegmenter;
    protected createFaceTracker(): FaceTracker;
    protected loadBackgroundImage(url: string, onLoad: (img: HTMLImageElement) => void): void;
    protected requestFrame(cb: FrameRequestCallback): number;
    protected cancelFrame(id: number): void;
    protected now(): number;
}
//# sourceMappingURL=engine.d.ts.map