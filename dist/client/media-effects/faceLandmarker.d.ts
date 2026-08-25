import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
/** MediaPipe Face Mesh landmark indices we care about. */
export declare const LANDMARK: {
    readonly FOREHEAD_TOP: 10;
    readonly CHIN: 152;
    readonly NOSE_TIP: 1;
    readonly LEFT_EYE_OUTER: 33;
    readonly LEFT_EYE_INNER: 133;
    readonly RIGHT_EYE_INNER: 362;
    readonly RIGHT_EYE_OUTER: 263;
    readonly LEFT_CHEEK: 234;
    readonly RIGHT_CHEEK: 454;
    readonly UPPER_LIP_TOP: 0;
    readonly LOWER_LIP_BOTTOM: 17;
};
/**
 * Module-level warmup: kick the WASM + model download without needing a
 * FaceTracker instance. Safe to call repeatedly (keyed singleton loader);
 * SSR-safe: no-op without window/document.
 */
export declare function warmupFaceLandmarker(): Promise<void>;
export declare class FaceTracker {
    private landmarker;
    private lastLandmarks;
    warmup(): Promise<void>;
    /**
     * Run landmark detection on the current video frame. Returns normalized
     * landmarks or null if no face detected / model not ready.
     */
    detect(video: HTMLVideoElement, timestampMs: number): NormalizedLandmark[] | null;
    close(): void;
}
//# sourceMappingURL=faceLandmarker.d.ts.map