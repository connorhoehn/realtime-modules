"use strict";
// Public barrel for @connorhoehn/realtime-modules/client/voice.
//
// Ambient (non-call) push-to-talk voice capture, and the context contract that
// decides where a spoken remark belongs.
//
// The three published surfaces, for consumers outside this directory:
//
//   ContextFrame            — WHERE an utterance attaches. Latched at t0, never
//                             re-decided. contextFrame.ts.
//   TranscriptReadyEvent    — { text, context, t0_ms, t1_ms, ... } delivered to
//                             every sink via subscribeTranscripts().
//   useVoiceCapture         — the hook a Transcribe button drives.
//
// Everything else here is implementation detail that happens to be exported for
// testing and for hosts that need finer control.
Object.defineProperty(exports, "__esModule", { value: true });
exports.silenceBytes = exports.s16ToBytes = exports.rmsS16 = exports.resampleLinear = exports.floatToS16 = exports.bytesToMs = exports.DEFAULT_SILENCE_RMS = exports.TARGET_SAMPLE_RATE = exports.isVoiceCaptureSupported = exports.PcmRecorder = exports.CAPTURE_ID_PATTERN = exports.isValidCaptureId = exports.generateCaptureId = exports.captureWsChannel = exports.captureRoutingKey = exports.UtteranceAggregator = exports.evaluateAttach = exports.attachTranscriptAsComment = exports.publishTranscript = exports.subscribeTranscripts = exports.resolveAnchor = exports.resolveTier = exports.buildContextFrame = exports.useVoiceCapture = void 0;
var useVoiceCapture_1 = require("./useVoiceCapture");
Object.defineProperty(exports, "useVoiceCapture", { enumerable: true, get: function () { return useVoiceCapture_1.useVoiceCapture; } });
var contextFrame_1 = require("./contextFrame");
Object.defineProperty(exports, "buildContextFrame", { enumerable: true, get: function () { return contextFrame_1.buildContextFrame; } });
Object.defineProperty(exports, "resolveTier", { enumerable: true, get: function () { return contextFrame_1.resolveTier; } });
Object.defineProperty(exports, "resolveAnchor", { enumerable: true, get: function () { return contextFrame_1.resolveAnchor; } });
var transcriptBus_1 = require("./transcriptBus");
Object.defineProperty(exports, "subscribeTranscripts", { enumerable: true, get: function () { return transcriptBus_1.subscribeTranscripts; } });
Object.defineProperty(exports, "publishTranscript", { enumerable: true, get: function () { return transcriptBus_1.publishTranscript; } });
var commentSink_1 = require("./commentSink");
Object.defineProperty(exports, "attachTranscriptAsComment", { enumerable: true, get: function () { return commentSink_1.attachTranscriptAsComment; } });
Object.defineProperty(exports, "evaluateAttach", { enumerable: true, get: function () { return commentSink_1.evaluateAttach; } });
var utteranceAggregator_1 = require("./utteranceAggregator");
Object.defineProperty(exports, "UtteranceAggregator", { enumerable: true, get: function () { return utteranceAggregator_1.UtteranceAggregator; } });
var captureChannel_1 = require("./captureChannel");
Object.defineProperty(exports, "captureRoutingKey", { enumerable: true, get: function () { return captureChannel_1.captureRoutingKey; } });
Object.defineProperty(exports, "captureWsChannel", { enumerable: true, get: function () { return captureChannel_1.captureWsChannel; } });
Object.defineProperty(exports, "generateCaptureId", { enumerable: true, get: function () { return captureChannel_1.generateCaptureId; } });
Object.defineProperty(exports, "isValidCaptureId", { enumerable: true, get: function () { return captureChannel_1.isValidCaptureId; } });
Object.defineProperty(exports, "CAPTURE_ID_PATTERN", { enumerable: true, get: function () { return captureChannel_1.CAPTURE_ID_PATTERN; } });
var pcmRecorder_1 = require("./pcmRecorder");
Object.defineProperty(exports, "PcmRecorder", { enumerable: true, get: function () { return pcmRecorder_1.PcmRecorder; } });
Object.defineProperty(exports, "isVoiceCaptureSupported", { enumerable: true, get: function () { return pcmRecorder_1.isVoiceCaptureSupported; } });
var pcm_1 = require("./pcm");
Object.defineProperty(exports, "TARGET_SAMPLE_RATE", { enumerable: true, get: function () { return pcm_1.TARGET_SAMPLE_RATE; } });
Object.defineProperty(exports, "DEFAULT_SILENCE_RMS", { enumerable: true, get: function () { return pcm_1.DEFAULT_SILENCE_RMS; } });
Object.defineProperty(exports, "bytesToMs", { enumerable: true, get: function () { return pcm_1.bytesToMs; } });
Object.defineProperty(exports, "floatToS16", { enumerable: true, get: function () { return pcm_1.floatToS16; } });
Object.defineProperty(exports, "resampleLinear", { enumerable: true, get: function () { return pcm_1.resampleLinear; } });
Object.defineProperty(exports, "rmsS16", { enumerable: true, get: function () { return pcm_1.rmsS16; } });
Object.defineProperty(exports, "s16ToBytes", { enumerable: true, get: function () { return pcm_1.s16ToBytes; } });
Object.defineProperty(exports, "silenceBytes", { enumerable: true, get: function () { return pcm_1.silenceBytes; } });
//# sourceMappingURL=index.js.map