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

import type { FaceLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { getMediaEffectsAssets } from './assets';

// Ownership mirrors segmenter.ts: every FaceTracker owns its FaceLandmarker,
// and only the WARMUP is shared (pre-built once, claimed by the first tracker
// to ask). A borrowed singleton broke the moment two engines existed — the
// settings dialog's preview engine closing it out from under the live call.
// See the note above PersonSegmenter's loader for the full failure.

let warmPromise: Promise<FaceLandmarker> | null = null;
let warmKey: string | null = null;

function assetKey(): string {
  const { wasmBase, faceLandmarkerModelUrl } = getMediaEffectsAssets();
  return `${wasmBase}|${faceLandmarkerModelUrl}`;
}

async function createLandmarkerInstance(): Promise<FaceLandmarker> {
  const { wasmBase, faceLandmarkerModelUrl } = getMediaEffectsAssets();
  const { FilesetResolver, FaceLandmarker: Ctor } = await import('@mediapipe/tasks-vision');
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

function warmLandmarker(): Promise<FaceLandmarker> {
  const key = assetKey();
  if (!warmPromise || warmKey !== key) {
    const stale = warmPromise;
    if (stale) stale.then((l) => l.close()).catch(() => {});
    warmKey = key;
    warmPromise = createLandmarkerInstance().catch((err) => {
      // Reset on failure so the next acquire retries instead of failing forever.
      if (warmKey === key) {
        warmPromise = null;
        warmKey = null;
      }
      throw err;
    });
  }
  return warmPromise;
}

function acquireLandmarker(): Promise<FaceLandmarker> {
  if (warmPromise && warmKey === assetKey()) {
    const claimed = warmPromise;
    warmPromise = null;
    warmKey = null;
    return claimed;
  }
  return createLandmarkerInstance();
}

/** MediaPipe Face Mesh landmark indices we care about. */
export const LANDMARK = {
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
} as const;

/**
 * Module-level warmup: kick the WASM + model download without needing a
 * FaceTracker instance. Safe to call repeatedly (keyed singleton loader);
 * SSR-safe: no-op without window/document.
 */
export function warmupFaceLandmarker(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve();
  }
  return warmLandmarker().then(() => undefined).catch(() => undefined);
}

export class FaceTracker {
  private landmarker: FaceLandmarker | null = null;
  private loading: Promise<void> | null = null;
  private generation = 0;
  private lastLandmarks: NormalizedLandmark[] | null = null;

  warmup(): Promise<void> {
    return warmupFaceLandmarker();
  }

  /**
   * Run landmark detection on the current video frame. Returns normalized
   * landmarks or null if no face detected / model not ready.
   */
  detect(video: HTMLVideoElement, timestampMs: number): NormalizedLandmark[] | null {
    if (!this.landmarker) {
      this.ensureLoading();
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
    } catch {
      return null;
    }
  }

  private ensureLoading(): void {
    if (this.loading) return;
    const gen = this.generation;
    this.loading = acquireLandmarker()
      .then((l) => {
        if (gen !== this.generation) {
          l.close();
          return;
        }
        this.landmarker = l;
      })
      .catch(() => {
        if (gen === this.generation) this.loading = null;
      });
  }

  /** Releases THIS tracker's graph only; other trackers and the warm slot
   *  are untouched. */
  close() {
    this.generation++;
    this.loading = null;
    this.landmarker?.close();
    this.landmarker = null;
  }
}
