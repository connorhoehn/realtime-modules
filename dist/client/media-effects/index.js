"use strict";
// Public barrel for the @connorhoehn/realtime-modules/client/media-effects
// subpath. Camera video-effects: CSS-filter presets, background blur /
// virtual backgrounds (MediaPipe selfie segmentation), and emoji face
// sprites (MediaPipe face landmarks) — all behind a LAZY engine that costs
// nothing until an effect is actually enabled.
//
// Like ./client/video, this subpath is deliberately NOT re-exported from
// the client root barrel: it pulls @mediapipe/tasks-vision types and is
// only relevant to camera-publishing surfaces.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useMediaEffects = exports.DEFAULT_EFFECTS_SETTINGS = exports.mediaEffectsSettingsEqual = exports.writePersistedSettings = exports.readPersistedSettings = exports.SEGMENT_FRAME_INTERVAL = exports.MASK_FEATHER_PX = exports.MASK_EMA_ALPHA = exports.MediaEffectsEngine = exports.getSpriteById = exports.FACE_SPRITES = exports.warmupFaceLandmarker = exports.LANDMARK = exports.FaceTracker = exports.warmupSegmenter = exports.shapeConfidence = exports.PersonSegmenter = exports.DEFAULT_FACE_LANDMARKER_MODEL_URL = exports.DEFAULT_SEGMENTER_MODEL_URL = exports.DEFAULT_WASM_BASE = exports.getMediaEffectsAssets = exports.setMediaEffectsAssets = exports.getBuiltInBackgrounds = exports.getFilterById = exports.DEFAULT_FILTER = exports.FILTER_PRESETS = void 0;
var presets_1 = require("./presets");
Object.defineProperty(exports, "FILTER_PRESETS", { enumerable: true, get: function () { return presets_1.FILTER_PRESETS; } });
Object.defineProperty(exports, "DEFAULT_FILTER", { enumerable: true, get: function () { return presets_1.DEFAULT_FILTER; } });
Object.defineProperty(exports, "getFilterById", { enumerable: true, get: function () { return presets_1.getFilterById; } });
var backgrounds_1 = require("./backgrounds");
Object.defineProperty(exports, "getBuiltInBackgrounds", { enumerable: true, get: function () { return backgrounds_1.getBuiltInBackgrounds; } });
var assets_1 = require("./assets");
Object.defineProperty(exports, "setMediaEffectsAssets", { enumerable: true, get: function () { return assets_1.setMediaEffectsAssets; } });
Object.defineProperty(exports, "getMediaEffectsAssets", { enumerable: true, get: function () { return assets_1.getMediaEffectsAssets; } });
Object.defineProperty(exports, "DEFAULT_WASM_BASE", { enumerable: true, get: function () { return assets_1.DEFAULT_WASM_BASE; } });
Object.defineProperty(exports, "DEFAULT_SEGMENTER_MODEL_URL", { enumerable: true, get: function () { return assets_1.DEFAULT_SEGMENTER_MODEL_URL; } });
Object.defineProperty(exports, "DEFAULT_FACE_LANDMARKER_MODEL_URL", { enumerable: true, get: function () { return assets_1.DEFAULT_FACE_LANDMARKER_MODEL_URL; } });
var segmenter_1 = require("./segmenter");
Object.defineProperty(exports, "PersonSegmenter", { enumerable: true, get: function () { return segmenter_1.PersonSegmenter; } });
Object.defineProperty(exports, "shapeConfidence", { enumerable: true, get: function () { return segmenter_1.shapeConfidence; } });
Object.defineProperty(exports, "warmupSegmenter", { enumerable: true, get: function () { return segmenter_1.warmupSegmenter; } });
var faceLandmarker_1 = require("./faceLandmarker");
Object.defineProperty(exports, "FaceTracker", { enumerable: true, get: function () { return faceLandmarker_1.FaceTracker; } });
Object.defineProperty(exports, "LANDMARK", { enumerable: true, get: function () { return faceLandmarker_1.LANDMARK; } });
Object.defineProperty(exports, "warmupFaceLandmarker", { enumerable: true, get: function () { return faceLandmarker_1.warmupFaceLandmarker; } });
var faceSprites_1 = require("./faceSprites");
Object.defineProperty(exports, "FACE_SPRITES", { enumerable: true, get: function () { return faceSprites_1.FACE_SPRITES; } });
Object.defineProperty(exports, "getSpriteById", { enumerable: true, get: function () { return faceSprites_1.getSpriteById; } });
var engine_1 = require("./engine");
Object.defineProperty(exports, "MediaEffectsEngine", { enumerable: true, get: function () { return engine_1.MediaEffectsEngine; } });
Object.defineProperty(exports, "MASK_EMA_ALPHA", { enumerable: true, get: function () { return engine_1.MASK_EMA_ALPHA; } });
Object.defineProperty(exports, "MASK_FEATHER_PX", { enumerable: true, get: function () { return engine_1.MASK_FEATHER_PX; } });
Object.defineProperty(exports, "SEGMENT_FRAME_INTERVAL", { enumerable: true, get: function () { return engine_1.SEGMENT_FRAME_INTERVAL; } });
var persistence_1 = require("./persistence");
Object.defineProperty(exports, "readPersistedSettings", { enumerable: true, get: function () { return persistence_1.readPersistedSettings; } });
Object.defineProperty(exports, "writePersistedSettings", { enumerable: true, get: function () { return persistence_1.writePersistedSettings; } });
Object.defineProperty(exports, "mediaEffectsSettingsEqual", { enumerable: true, get: function () { return persistence_1.mediaEffectsSettingsEqual; } });
Object.defineProperty(exports, "DEFAULT_EFFECTS_SETTINGS", { enumerable: true, get: function () { return persistence_1.DEFAULT_EFFECTS_SETTINGS; } });
var useMediaEffects_1 = require("./useMediaEffects");
Object.defineProperty(exports, "useMediaEffects", { enumerable: true, get: function () { return useMediaEffects_1.useMediaEffects; } });
//# sourceMappingURL=index.js.map