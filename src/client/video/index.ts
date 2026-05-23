// Public barrel for the @connorhoehn/realtime-modules/client/video
// subpath. Consumers import the hooks + context + low-level transport
// from here. Internal lib/* modules stay unexported — callers should
// reach for the hooks first; transport helpers are surfaced for
// advanced cases (custom retry, headless tests).

export {
  LVSProvider,
  useLVSContext,
  type LVSConfig,
  type LVSLog,
  type LogLevel,
} from './LVSProvider';

export {
  useLVSPublisher,
  type UseLVSPublisherOptions,
  type UseLVSPublisherResult,
  type LVSPublisherStats,
  type LVSPhase,
} from './useLVSPublisher';

export {
  useLVSSubscriber,
  type UseLVSSubscriberOptions,
  type UseLVSSubscriberResult,
  type LVSSubscriberStats,
  type LVSSubscriberPhase,
} from './useLVSSubscriber';

export {
  useLVSHangout,
  type UseLVSHangoutOptions,
  type UseLVSHangoutResult,
  type HangoutParticipant,
} from './useLVSHangout';

export {
  useLVSRecordings,
  type UseLVSRecordingsOptions,
  type UseLVSRecordingsResult,
  type LVSRecording,
  type LVSRecordingSegment,
} from './useLVSRecordings';

export {
  useLVSHlsPlayer,
  type UseLVSHlsPlayerOptions,
  type UseLVSHlsPlayerResult,
} from './useLVSHlsPlayer';

export {
  useLiveCaptions,
  type CaptionLine,
  type UseLiveCaptionsOptions,
} from './useLiveCaptions';

// Transport re-exports for advanced consumers (custom WHIP retry loops,
// SSR-shimmed fetch in tests). The hooks above own the common path.
export {
  whipPublish,
  whepPublish,
  fetchIceServers,
  LVSApiError,
} from './lib/transport';

export { decodeJwt, decodeArn } from './lib/jwt';

export {
  waitForIceGather,
  formatBitrate,
  classifyNetQ,
  type NetQuality,
} from './lib/sdp';
