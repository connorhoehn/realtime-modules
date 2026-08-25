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

let landmarkerPromise: Promise<FaceLandmarker> | null = null;
let landmarkerKey: string | null = null;

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

function loadLandmarker(): Promise<FaceLandmarker> {
  const { wasmBase, faceLandmarkerModelUrl } = getMediaEffectsAssets();
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

export class FaceTracker {
  private landmarker: FaceLandmarker | null = null;
  private lastLandmarks: NormalizedLandmark[] | null = null;

  warmup(): Promise<void> {
    return loadLandmarker().then(() => undefined).catch(() => undefined);
  }

  /**
   * Run landmark detection on the current video frame. Returns normalized
   * landmarks or null if no face detected / model not ready.
   */
  detect(video: HTMLVideoElement, timestampMs: number): NormalizedLandmark[] | null {
    if (!this.landmarker) {
      loadLandmarker().then((l) => { this.landmarker = l; }).catch(() => {});
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

  close() {
    this.landmarker?.close();
    this.landmarker = null;
    landmarkerPromise = null;
    landmarkerKey = null;
  }
}
