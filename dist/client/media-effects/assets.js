"use strict";
// realtime-modules/src/client/media-effects/assets.ts
//
// Asset URL configuration for the MediaPipe models this subpath loads at
// runtime. The reference implementation hard-coded CDN URLs; here they are
// overridable so self-hosted deployments (CSP-locked pages, air-gapped
// environments) can serve the ~3 MB WASM bundle and model files from their
// own origin via setMediaEffectsAssets().
//
// The defaults below ARE the reference CDN locations and work out of the
// box in any environment that allows those origins:
//   - WASM: jsdelivr build of @mediapipe/tasks-vision@0.10.34
//   - models: Google's public mediapipe-models bucket
//
// Timing contract: the lazy loaders in segmenter.ts / faceLandmarker.ts
// key their singleton promises off the RESOLVED urls, so calling
// setMediaEffectsAssets() before the first load Just Works. Changing
// assets AFTER a model has loaded requires close() on the live
// PersonSegmenter / FaceTracker (which also resets the loader singleton)
// before the new URLs take effect.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_FACE_LANDMARKER_MODEL_URL = exports.DEFAULT_SEGMENTER_MODEL_URL = exports.DEFAULT_WASM_BASE = void 0;
exports.setMediaEffectsAssets = setMediaEffectsAssets;
exports.getMediaEffectsAssets = getMediaEffectsAssets;
exports.DEFAULT_WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm';
exports.DEFAULT_SEGMENTER_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite';
exports.DEFAULT_FACE_LANDMARKER_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
let current = {
    wasmBase: exports.DEFAULT_WASM_BASE,
    segmenterModelUrl: exports.DEFAULT_SEGMENTER_MODEL_URL,
    faceLandmarkerModelUrl: exports.DEFAULT_FACE_LANDMARKER_MODEL_URL,
};
/** Merge-set: only the provided fields are overridden, so callers can
 *  self-host just the WASM (the CSP-sensitive part) and keep model CDNs. */
function setMediaEffectsAssets(assets) {
    current = { ...current, ...assets };
}
function getMediaEffectsAssets() {
    return current;
}
//# sourceMappingURL=assets.js.map