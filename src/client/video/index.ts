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
  type RemoteParticipant,
  type HangoutConnectionState,
} from './useLVSHangout';

export {
  LVSHangoutSessionContext,
  LVSHangoutSessionProvider,
  useLVSHangoutShared,
  type LVSHangoutSessionProviderProps,
} from './useLVSHangoutShared';

export {
  useLVSRecordings,
  type UseLVSRecordingsOptions,
  type UseLVSRecordingsResult,
  type LVSRecording,
  type LVSRecordingSegment,
} from './useLVSRecordings';

// Live vs DVR are different questions, so they are different hooks:
// useLVSLiveHls answers "what is happening now" (many viewers, seconds of
// latency); useLVSHlsPlayer answers "replay this window".
export {
  useLVSLiveHls,
  type UseLVSLiveHlsOptions,
  type UseLVSLiveHlsResult,
} from './useLVSLiveHls';

// The audience figure that makes a broadcast a broadcast. LVS has tracked it
// all along; nothing was asking.
export {
  useLVSViewerCount,
  type UseLVSViewerCountOptions,
  type UseLVSViewerCountResult,
} from './useLVSViewerCount';

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

// Document calls (2026-09-24): device enumeration, local media settings, the
// call itself, and its rings. See realtime-examples
// docs/design/document-calls/SPEC.md §5.3.
export {
  useMediaDevices,
  toDeviceOptions,
  isSpeakerSelectionSupported,
  type UseMediaDevicesOptions,
  type UseMediaDevicesResult,
} from './useMediaDevices';

export {
  useAudioVideoSettings,
  readAudioVideoSettings,
  audioVideoConstraints,
  AUDIO_VIDEO_SETTINGS_KEY,
  type UseAudioVideoSettingsOptions,
  type UseAudioVideoSettingsResult,
} from './useAudioVideoSettings';

export {
  useDocumentCall,
  mergeDocumentCall,
  toDocumentCallSession,
  type DocumentCall,
  type DocumentCallMediaBinding,
  type DocumentCallPhase,
  type DocumentCallStartInput,
  type UseDocumentCallOptions,
  type UseDocumentCallResult,
} from './useDocumentCall';

export {
  useIncomingDocumentCalls,
  parseDocumentInvite,
  type IncomingDocumentCall,
  type IncomingDocumentCallPerson,
  type UseIncomingDocumentCallsOptions,
  type UseIncomingDocumentCallsResult,
} from './useIncomingDocumentCalls';

export type { DocumentCallGateway } from './documentCallGateway';

// Conversation calls (0.98.0): the DM / room call docked above a chat
// composer — ring, accept, live tiles, leave — against the gateway's `call`
// service and platform-api, with a pure mapping onto ui-components' CallDock.
// docs/design/conversation-call-port.md.
export {
  useConversationCall,
  callingLabel,
  type UseConversationCallOptions,
  type ConversationCallResult,
} from './useConversationCall';

export {
  useIncomingConversationCalls,
  parseConversationInvite,
  type UseIncomingConversationCallsOptions,
  type UseIncomingConversationCallsResult,
} from './useIncomingConversationCalls';

export {
  conversationCallDockProps,
  DOCK_PHASE,
  type ConversationCallDockState,
  type ConversationCallDockUi,
  type ConversationCallDockProps,
  type ConversationCallDockParticipant,
} from './conversationCallDockProps';

export {
  useDevicePreferences,
  readDevicePreferences,
  deviceConstraints,
  DEVICE_PREFERENCES_KEY,
} from './useDevicePreferences';

export { dmLobbyName, dmLobbyPrefix, parseDmLobby, channelForLobby, lobbyForChannel, isDmLobby } from './conversationLobby';
export type { ParsedDmLobby } from './conversationLobby';

export type {
  ConversationCall,
  ConversationCallDeclineReason,
  ConversationCallEvent,
  ConversationCallGateway,
  ConversationCallParticipant,
  ConversationCallPhase,
  DevicePreferences,
  IncomingConversationCall,
} from './conversationCallTypes';

export {
  DEFAULT_AUDIO_VIDEO_SETTINGS,
  type AudioVideoSettings,
  type CallQuality,
  type DeviceOption,
  type DocumentCallAwarenessParticipant,
  type DocumentCallInvite,
  type DocumentCallMediaMember,
  type DocumentCallMeta,
  type DocumentCallParticipant,
  type DocumentCallParticipantState,
  type DocumentCallPresenting,
  type DocumentCallSession,
  type MediaPermission,
} from './documentCallTypes';

// Transport re-exports for advanced consumers (custom WHIP retry loops,
// SSR-shimmed fetch in tests). The hooks above own the common path.
export {
  whipPublish,
  whepPublish,
  fetchIceServers,
  resolveResourceLocation,
  LVSApiError,
} from './lib/transport';
export type { TransportLog } from './lib/transport';

export { decodeJwt, decodeArn } from './lib/jwt';

export {
  waitForIceGather,
  formatBitrate,
  classifyNetQ,
  type NetQuality,
} from './lib/sdp';
