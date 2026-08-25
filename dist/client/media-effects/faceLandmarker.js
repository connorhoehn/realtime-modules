"use strict";
// realtime-modules/src/client/media-effects/faceLandmarker.ts
//
// MediaPipe Face Landmarker wrapper. 468 per-face landmarks at ~30fps on
// desktop GPU. Lazy-initialized like the segmenter so the ~3 MB WASM+model
// download doesn't hit users who never enable a face sprite.
//
// Returns normalized landmarks (x/y in [0, 1] relative to the source image)
// which the engine converts to canvas pixel coordinates at draw time.
//
// Same porting changes as segmenter.ts: asset URLs come from assets.ts and
// the loader singleton keys off the resolved URLs (change assets before
// first load, or close() after); the tasks-vision bundle is imported lazily
// so this module is SSR/node safe to require.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FaceTracker = exports.LANDMARK = void 0;
const assets_1 = require("./assets");
let landmarkerPromise = null;
let landmarkerKey = null;
async function createLandmarkerInstance() {
    const { wasmBase, faceLandmarkerModelUrl } = (0, assets_1.getMediaEffectsAssets)();
    const { FilesetResolver, FaceLandmarker: Ctor } = await Promise.resolve().then(() => __importStar(require('@mediapipe/tasks-vision')));
    const fileset = await FilesetResolver.forVisionTasks(wasmBase);
    return Ctor.createFromOptions(fileset, {
        baseOptions: {
            modelAssetPath: faceLandmarkerModelUrl,
            delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
    });
}
function loadLandmarker() {
    const { wasmBase, faceLandmarkerModelUrl } = (0, assets_1.getMediaEffectsAssets)();
    const key = `${wasmBase}|${faceLandmarkerModelUrl}`;
    if (!landmarkerPromise || landmarkerKey !== key) {
        landmarkerKey = key;
        landmarkerPromise = createLandmarkerInstance().catch((err) => {
            // Reset on failure so the next detect() retries instead of failing forever.
            if (landmarkerKey === key) {
                landmarkerPromise = null;
                landmarkerKey = null;
            }
            throw err;
        });
    }
    return landmarkerPromise;
}
/** MediaPipe Face Mesh landmark indices we care about. */
exports.LANDMARK = {
    FOREHEAD_TOP: 10,
    CHIN: 152,
    NOSE_TIP: 1,
    LEFT_EYE_OUTER: 33,
    LEFT_EYE_INNER: 133,
    RIGHT_EYE_INNER: 362,
    RIGHT_EYE_OUTER: 263,
    LEFT_CHEEK: 234,
    RIGHT_CHEEK: 454,
    UPPER_LIP_TOP: 0,
    LOWER_LIP_BOTTOM: 17,
};
class FaceTracker {
    landmarker = null;
    lastLandmarks = null;
    warmup() {
        return loadLandmarker().then(() => undefined).catch(() => undefined);
    }
    /**
     * Run landmark detection on the current video frame. Returns normalized
     * landmarks or null if no face detected / model not ready.
     */
    detect(video, timestampMs) {
        if (!this.landmarker) {
            loadLandmarker().then((l) => { this.landmarker = l; }).catch(() => { });
            return null;
        }
        try {
            const result = this.landmarker.detectForVideo(video, timestampMs);
            const faces = result.faceLandmarks;
            if (faces && faces.length > 0) {
                this.lastLandmarks = faces[0];
                return this.lastLandmarks;
            }
            return null;
        }
        catch {
            return null;
        }
    }
    close() {
        this.landmarker?.close();
        this.landmarker = null;
        landmarkerPromise = null;
        landmarkerKey = null;
    }
}
exports.FaceTracker = FaceTracker;
//# sourceMappingURL=faceLandmarker.js.map