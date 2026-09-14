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
exports.warmupSegmenter = warmupSegmenter;
const assets_1 = require("./assets");
// ------------------------------------------------------------- ownership
//
// Every PersonSegmenter OWNS its ImageSegmenter. It used to borrow one
// module-level singleton, and that is exactly wrong for the one situation
// where two segmenters exist at once: useMediaEffects builds a SECOND engine
// for the settings dialog's preview, so for the length of a preview session
// the live call and the preview both fed frames — with two unrelated
// timestamp clocks — into one MediaPipe graph, and the moment the preview
// ended its teardown called close() on the graph the live call was still
// drawing with. Every live frame after that failed with
// `AddPacketToInputStream() is called before StartRun()` and the mask froze
// on whatever it last was — a ghost of the person, offset from where they
// now are. Changing your background mid-call is what triggered it.
//
// What is still shared is the WARMUP: the effects UI kicks the ~3 MB WASM +
// model load before anyone picks an effect, and that pre-built instance is
// handed to the first PersonSegmenter that asks (it becomes that instance's
// to close). A second concurrent segmenter builds its own; the browser cache
// makes that a GPU init, not a second download.
let warmPromise = null;
let warmKey = null;
function assetKey() {
    const { wasmBase, segmenterModelUrl } = (0, assets_1.getMediaEffectsAssets)();
    return `${wasmBase}|${segmenterModelUrl}`;
}
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
/** Pre-build one instance for the next PersonSegmenter to claim. Keyed on
 *  the asset URLs: a warm instance built against old assets is released,
 *  since it would segment with the wrong model. */
function warmSegmenter() {
    const key = assetKey();
    if (!warmPromise || warmKey !== key) {
        const stale = warmPromise;
        if (stale)
            stale.then((s) => s.close()).catch(() => { });
        warmKey = key;
        warmPromise = createSegmenterInstance().catch((err) => {
            // Reset on failure so a transient network error doesn't poison the
            // warm slot forever — the next acquire retries the download.
            if (warmKey === key) {
                warmPromise = null;
                warmKey = null;
            }
            throw err;
        });
    }
    return warmPromise;
}
/** The warm instance if one matches the current assets — it leaves the warm
 *  slot and becomes the caller's to close — otherwise a fresh build. */
function acquireSegmenter() {
    if (warmPromise && warmKey === assetKey()) {
        const claimed = warmPromise;
        warmPromise = null;
        warmKey = null;
        return claimed;
    }
    return createSegmenterInstance();
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
/**
 * Module-level warmup: kick the WASM + model download without needing a
 * PersonSegmenter instance (the app calls this when the effects UI opens,
 * before any effect is selected, so first selection doesn't freeze on
 * model init). Safe to call repeatedly — the loader is a keyed singleton.
 * SSR-safe: no-op without window/document.
 */
function warmupSegmenter() {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return Promise.resolve();
    }
    return warmSegmenter().then(() => undefined).catch(() => undefined);
}
class PersonSegmenter {
    segmenter = null;
    /** In-flight acquire, so a frame loop asking every frame starts one load. */
    loading = null;
    /** Bumped by close(); an acquire that lands from an older generation is
     *  released, never installed. */
    generation = 0;
    maskCanvas = null;
    maskCtx = null;
    imageData = null;
    warmup() {
        return warmupSegmenter();
    }
    /**
     * Run segmentation on the current video frame. Returns a canvas whose
     * alpha encodes per-pixel person probability. Null until model loads.
     */
    segment(video, timestampMs) {
        if (!this.segmenter) {
            this.ensureLoading();
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
    ensureLoading() {
        if (this.loading)
            return;
        const gen = this.generation;
        this.loading = acquireSegmenter()
            .then((s) => {
            if (gen !== this.generation) {
                // Closed while the model was loading. Nothing else will ever
                // release this instance, so do it here.
                s.close();
                return;
            }
            this.segmenter = s;
        })
            .catch(() => {
            // Transient failure: clear so the next frame retries.
            if (gen === this.generation)
                this.loading = null;
        });
    }
    /** Releases THIS segmenter's graph only. Other PersonSegmenters — and the
     *  warm slot — are untouched. Safe to segment() again afterwards: it
     *  acquires a fresh instance. */
    close() {
        this.generation++;
        this.loading = null;
        this.segmenter?.close();
        this.segmenter = null;
    }
}
exports.PersonSegmenter = PersonSegmenter;
//# sourceMappingURL=segmenter.js.map