"use strict";
// realtime-modules/src/client/media-effects/segmenter.ts
//
// MediaPipe Selfie Segmentation wrapper.
//
// Uses CONFIDENCE mask (Float32Array of per-pixel probabilities 0.0–1.0)
// instead of the binary category mask — yields soft edges with no polarity
// ambiguity, and the alpha channel can encode probability directly so
// composites look natural against any background.
//
// Output: an HTMLCanvasElement whose alpha channel = segmentation confidence
// (255 = definite person, 0 = definite background, smooth gradient at edges).
//
// Ported from videonowandlater with two changes:
//   - asset URLs come from assets.ts (self-hostable) instead of constants;
//     the singleton loader keys off the resolved URLs so setMediaEffectsAssets
//     before first load takes effect (after a load, close() first).
//   - no document access at module load or in the constructor (SSR-safe);
//     the mask canvas is created lazily on the first segment() call. The
//     @mediapipe/tasks-vision bundle itself is imported lazily inside the
//     loader for the same reason.
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
exports.PersonSegmenter = void 0;
exports.shapeConfidence = shapeConfidence;
const assets_1 = require("./assets");
let segmenterPromise = null;
let segmenterKey = null;
async function createSegmenterInstance() {
    const { wasmBase, segmenterModelUrl } = (0, assets_1.getMediaEffectsAssets)();
    const { FilesetResolver, ImageSegmenter: Ctor } = await Promise.resolve().then(() => __importStar(require('@mediapipe/tasks-vision')));
    const fileset = await FilesetResolver.forVisionTasks(wasmBase);
    return Ctor.createFromOptions(fileset, {
        baseOptions: {
            modelAssetPath: segmenterModelUrl,
            delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        // Confidence mask gives soft alpha; category would be binary/blocky.
        outputCategoryMask: false,
        outputConfidenceMasks: true,
    });
}
function loadSegmenter() {
    const { wasmBase, segmenterModelUrl } = (0, assets_1.getMediaEffectsAssets)();
    const key = `${wasmBase}|${segmenterModelUrl}`;
    if (!segmenterPromise || segmenterKey !== key) {
        segmenterKey = key;
        segmenterPromise = createSegmenterInstance().catch((err) => {
            // Reset on failure so a transient network error doesn't poison the
            // singleton forever — the next segment() retries the download.
            if (segmenterKey === key) {
                segmenterPromise = null;
                segmenterKey = null;
            }
            throw err;
        });
    }
    return segmenterPromise;
}
/**
 * Alpha-shaping curve applied to raw per-pixel person probabilities.
 * A small threshold curve sharpens the edge around 0.5 so low-confidence
 * spray doesn't leak through, but keeps feathering for a natural silhouette:
 *   curve(p) = clamp(1.8 * p - 0.4, 0, 1)  → 0 below 0.22, 1 above 0.78
 * Exported as a pure function so the curve is unit-testable without canvas.
 */
function shapeConfidence(p) {
    return Math.max(0, Math.min(1, 1.8 * p - 0.4));
}
class PersonSegmenter {
    segmenter = null;
    maskCanvas = null;
    maskCtx = null;
    imageData = null;
    warmup() {
        return loadSegmenter().then(() => undefined).catch(() => undefined);
    }
    /**
     * Run segmentation on the current video frame. Returns a canvas whose
     * alpha encodes per-pixel person probability. Null until model loads.
     */
    segment(video, timestampMs) {
        if (!this.segmenter) {
            loadSegmenter().then((s) => { this.segmenter = s; }).catch(() => { });
            return null;
        }
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h)
            return null;
        if (!this.maskCanvas) {
            // Lazy: keeps `new PersonSegmenter()` DOM-free until first real frame.
            this.maskCanvas = document.createElement('canvas');
            this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
        }
        if (this.maskCanvas.width !== w || this.maskCanvas.height !== h) {
            this.maskCanvas.width = w;
            this.maskCanvas.height = h;
            this.imageData = null;
        }
        if (!this.maskCtx)
            return null;
        let mpMask;
        try {
            const result = this.segmenter.segmentForVideo(video, timestampMs);
            // Selfie Segmenter returns exactly one confidence mask (index 0 = person)
            mpMask = result.confidenceMasks?.[0];
            if (!mpMask)
                return null;
            const probs = mpMask.getAsFloat32Array();
            if (!this.imageData || this.imageData.width !== w || this.imageData.height !== h) {
                this.imageData = this.maskCtx.createImageData(w, h);
            }
            const data = this.imageData.data;
            // Alpha = shaped confidence * 255 (see shapeConfidence for the curve).
            for (let i = 0, j = 0; i < probs.length; i++, j += 4) {
                const shaped = shapeConfidence(probs[i]);
                data[j] = 255;
                data[j + 1] = 255;
                data[j + 2] = 255;
                data[j + 3] = (shaped * 255) | 0;
            }
            this.maskCtx.putImageData(this.imageData, 0, 0);
            return this.maskCanvas;
        }
        finally {
            mpMask?.close();
        }
    }
    close() {
        this.segmenter?.close();
        this.segmenter = null;
        segmenterPromise = null;
        segmenterKey = null;
    }
}
exports.PersonSegmenter = PersonSegmenter;
//# sourceMappingURL=segmenter.js.map