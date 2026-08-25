// Public barrel for the @connorhoehn/realtime-modules/client/media-effects
// subpath. Camera video-effects: CSS-filter presets, background blur /
// virtual backgrounds (MediaPipe selfie segmentation), and emoji face
// sprites (MediaPipe face landmarks) — all behind a LAZY engine that costs
// nothing until an effect is actually enabled.
//
// Like ./client/video, this subpath is deliberately NOT re-exported from
// the client root barrel: it pulls @mediapipe/tasks-vision types and is
// only relevant to camera-publishing surfaces.

export {
  FILTER_PRESETS,
  DEFAULT_FILTER,
  getFilterById,
  type FilterPreset,
} from './presets';

export {
  getBuiltInBackgrounds,
  type BackgroundOption,
} from './backgrounds';

export {
  setMediaEffectsAssets,
  getMediaEffectsAssets,
  DEFAULT_WASM_BASE,
  DEFAULT_SEGMENTER_MODEL_URL,
  DEFAULT_FACE_LANDMARKER_MODEL_URL,
  type MediaEffectsAssets,
} from './assets';

export {
  PersonSegmenter,
  shapeConfidence,
  warmupSegmenter,
} from './segmenter';

export {
  FaceTracker,
  LANDMARK,
  warmupFaceLandmarker,
} from './faceLandmarker';

export {
  FACE_SPRITES,
  getSpriteById,
  type FaceSprite,
} from './faceSprites';

export {
  MediaEffectsEngine,
  MASK_EMA_ALPHA,
  MASK_FEATHER_PX,
  SEGMENT_FRAME_INTERVAL,
  type BackgroundMode,
  type OutputChangeListener,
  type WarmupTarget,
} from './engine';

export {
  readPersistedSettings,
  writePersistedSettings,
  DEFAULT_EFFECTS_SETTINGS,
  type PersistedEffectsSettings,
  type SettingsStorage,
} from './persistence';

export {
  useMediaEffects,
  type UseMediaEffectsOptions,
  type MediaEffectsController,
} from './useMediaEffects';
