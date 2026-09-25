"use strict";
// Types shared by the document-call hooks (useMediaDevices,
// useAudioVideoSettings, useDocumentCall, useIncomingDocumentCalls).
// realtime-examples docs/design/document-calls/SPEC.md §4.1 and §5.3.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_AUDIO_VIDEO_SETTINGS = void 0;
exports.DEFAULT_AUDIO_VIDEO_SETTINGS = {
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    volume: 0.65,
    mirrorPreview: true,
    quality: 'auto',
    frameRate: 'auto',
    rememberDevices: true,
};
//# sourceMappingURL=documentCallTypes.js.map