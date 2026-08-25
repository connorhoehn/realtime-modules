export interface MediaEffectsAssets {
    /** Base URL of the @mediapipe/tasks-vision WASM directory. */
    wasmBase?: string;
    /** Selfie-segmentation model (.tflite) URL. */
    segmenterModelUrl?: string;
    /** Face Landmarker model (.task) URL. */
    faceLandmarkerModelUrl?: string;
}
export declare const DEFAULT_WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm";
export declare const DEFAULT_SEGMENTER_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/1/selfie_segmenter_landscape.tflite";
export declare const DEFAULT_FACE_LANDMARKER_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
/** Merge-set: only the provided fields are overridden, so callers can
 *  self-host just the WASM (the CSP-sensitive part) and keep model CDNs. */
export declare function setMediaEffectsAssets(assets: MediaEffectsAssets): void;
export declare function getMediaEffectsAssets(): Required<MediaEffectsAssets>;
//# sourceMappingURL=assets.d.ts.map