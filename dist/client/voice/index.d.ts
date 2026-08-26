export { useVoiceCapture, type UseVoiceCaptureOptions, type UseVoiceCaptureResult, type VoiceCaptureState, } from './useVoiceCapture';
export { buildContextFrame, resolveTier, resolveAnchor, type CaptureContextSample, type ContextAnchor, type ContextConfidence, type ContextFrame, type ResolveContextOptions, type TargetTier, } from './contextFrame';
export { subscribeTranscripts, publishTranscript, type TranscriptHandler, type TranscriptReadyEvent, } from './transcriptBus';
export { attachTranscriptAsComment, evaluateAttach, type AttachRefusal, type AttachResult, type AttachTranscriptOptions, } from './commentSink';
export { UtteranceAggregator, type AggregatedUtterance, type AggregatorOptions, type CaptionLineIn, type UtteranceOutcome, } from './utteranceAggregator';
export { captureRoutingKey, captureWsChannel, generateCaptureId, isValidCaptureId, CAPTURE_ID_PATTERN, } from './captureChannel';
export { PcmRecorder, isVoiceCaptureSupported, type PcmChunk, type PcmRecorderOptions, } from './pcmRecorder';
export { TARGET_SAMPLE_RATE, DEFAULT_SILENCE_RMS, bytesToMs, floatToS16, resampleLinear, rmsS16, s16ToBytes, silenceBytes, } from './pcm';
//# sourceMappingURL=index.d.ts.map