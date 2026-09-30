"use strict";
// Public barrel for the @connorhoehn/realtime-modules/client/video
// subpath. Consumers import the hooks + context + low-level transport
// from here. Internal lib/* modules stay unexported — callers should
// reach for the hooks first; transport helpers are surfaced for
// advanced cases (custom retry, headless tests).
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyNetQ = exports.formatBitrate = exports.waitForIceGather = exports.decodeArn = exports.decodeJwt = exports.LVSApiError = exports.resolveResourceLocation = exports.fetchIceServers = exports.whepPublish = exports.whipPublish = exports.DEFAULT_AUDIO_VIDEO_SETTINGS = exports.isDmLobby = exports.lobbyForChannel = exports.channelForLobby = exports.dmLobbyName = exports.DEVICE_PREFERENCES_KEY = exports.deviceConstraints = exports.readDevicePreferences = exports.useDevicePreferences = exports.DOCK_PHASE = exports.conversationCallDockProps = exports.parseConversationInvite = exports.useIncomingConversationCalls = exports.callingLabel = exports.useConversationCall = exports.parseDocumentInvite = exports.useIncomingDocumentCalls = exports.toDocumentCallSession = exports.mergeDocumentCall = exports.useDocumentCall = exports.AUDIO_VIDEO_SETTINGS_KEY = exports.audioVideoConstraints = exports.readAudioVideoSettings = exports.useAudioVideoSettings = exports.isSpeakerSelectionSupported = exports.toDeviceOptions = exports.useMediaDevices = exports.useLiveCaptions = exports.useLVSHlsPlayer = exports.useLVSViewerCount = exports.useLVSLiveHls = exports.useLVSRecordings = exports.useLVSHangoutShared = exports.LVSHangoutSessionProvider = exports.LVSHangoutSessionContext = exports.useLVSHangout = exports.useLVSSubscriber = exports.useLVSPublisher = exports.useLVSContext = exports.LVSProvider = void 0;
var LVSProvider_1 = require("./LVSProvider");
Object.defineProperty(exports, "LVSProvider", { enumerable: true, get: function () { return LVSProvider_1.LVSProvider; } });
Object.defineProperty(exports, "useLVSContext", { enumerable: true, get: function () { return LVSProvider_1.useLVSContext; } });
var useLVSPublisher_1 = require("./useLVSPublisher");
Object.defineProperty(exports, "useLVSPublisher", { enumerable: true, get: function () { return useLVSPublisher_1.useLVSPublisher; } });
var useLVSSubscriber_1 = require("./useLVSSubscriber");
Object.defineProperty(exports, "useLVSSubscriber", { enumerable: true, get: function () { return useLVSSubscriber_1.useLVSSubscriber; } });
var useLVSHangout_1 = require("./useLVSHangout");
Object.defineProperty(exports, "useLVSHangout", { enumerable: true, get: function () { return useLVSHangout_1.useLVSHangout; } });
var useLVSHangoutShared_1 = require("./useLVSHangoutShared");
Object.defineProperty(exports, "LVSHangoutSessionContext", { enumerable: true, get: function () { return useLVSHangoutShared_1.LVSHangoutSessionContext; } });
Object.defineProperty(exports, "LVSHangoutSessionProvider", { enumerable: true, get: function () { return useLVSHangoutShared_1.LVSHangoutSessionProvider; } });
Object.defineProperty(exports, "useLVSHangoutShared", { enumerable: true, get: function () { return useLVSHangoutShared_1.useLVSHangoutShared; } });
var useLVSRecordings_1 = require("./useLVSRecordings");
Object.defineProperty(exports, "useLVSRecordings", { enumerable: true, get: function () { return useLVSRecordings_1.useLVSRecordings; } });
// Live vs DVR are different questions, so they are different hooks:
// useLVSLiveHls answers "what is happening now" (many viewers, seconds of
// latency); useLVSHlsPlayer answers "replay this window".
var useLVSLiveHls_1 = require("./useLVSLiveHls");
Object.defineProperty(exports, "useLVSLiveHls", { enumerable: true, get: function () { return useLVSLiveHls_1.useLVSLiveHls; } });
// The audience figure that makes a broadcast a broadcast. LVS has tracked it
// all along; nothing was asking.
var useLVSViewerCount_1 = require("./useLVSViewerCount");
Object.defineProperty(exports, "useLVSViewerCount", { enumerable: true, get: function () { return useLVSViewerCount_1.useLVSViewerCount; } });
var useLVSHlsPlayer_1 = require("./useLVSHlsPlayer");
Object.defineProperty(exports, "useLVSHlsPlayer", { enumerable: true, get: function () { return useLVSHlsPlayer_1.useLVSHlsPlayer; } });
var useLiveCaptions_1 = require("./useLiveCaptions");
Object.defineProperty(exports, "useLiveCaptions", { enumerable: true, get: function () { return useLiveCaptions_1.useLiveCaptions; } });
// Document calls (2026-09-24): device enumeration, local media settings, the
// call itself, and its rings. See realtime-examples
// docs/design/document-calls/SPEC.md §5.3.
var useMediaDevices_1 = require("./useMediaDevices");
Object.defineProperty(exports, "useMediaDevices", { enumerable: true, get: function () { return useMediaDevices_1.useMediaDevices; } });
Object.defineProperty(exports, "toDeviceOptions", { enumerable: true, get: function () { return useMediaDevices_1.toDeviceOptions; } });
Object.defineProperty(exports, "isSpeakerSelectionSupported", { enumerable: true, get: function () { return useMediaDevices_1.isSpeakerSelectionSupported; } });
var useAudioVideoSettings_1 = require("./useAudioVideoSettings");
Object.defineProperty(exports, "useAudioVideoSettings", { enumerable: true, get: function () { return useAudioVideoSettings_1.useAudioVideoSettings; } });
Object.defineProperty(exports, "readAudioVideoSettings", { enumerable: true, get: function () { return useAudioVideoSettings_1.readAudioVideoSettings; } });
Object.defineProperty(exports, "audioVideoConstraints", { enumerable: true, get: function () { return useAudioVideoSettings_1.audioVideoConstraints; } });
Object.defineProperty(exports, "AUDIO_VIDEO_SETTINGS_KEY", { enumerable: true, get: function () { return useAudioVideoSettings_1.AUDIO_VIDEO_SETTINGS_KEY; } });
var useDocumentCall_1 = require("./useDocumentCall");
Object.defineProperty(exports, "useDocumentCall", { enumerable: true, get: function () { return useDocumentCall_1.useDocumentCall; } });
Object.defineProperty(exports, "mergeDocumentCall", { enumerable: true, get: function () { return useDocumentCall_1.mergeDocumentCall; } });
Object.defineProperty(exports, "toDocumentCallSession", { enumerable: true, get: function () { return useDocumentCall_1.toDocumentCallSession; } });
var useIncomingDocumentCalls_1 = require("./useIncomingDocumentCalls");
Object.defineProperty(exports, "useIncomingDocumentCalls", { enumerable: true, get: function () { return useIncomingDocumentCalls_1.useIncomingDocumentCalls; } });
Object.defineProperty(exports, "parseDocumentInvite", { enumerable: true, get: function () { return useIncomingDocumentCalls_1.parseDocumentInvite; } });
// Conversation calls (0.98.0): the DM / room call docked above a chat
// composer — ring, accept, live tiles, leave — against the gateway's `call`
// service and platform-api, with a pure mapping onto ui-components' CallDock.
// docs/design/conversation-call-port.md.
var useConversationCall_1 = require("./useConversationCall");
Object.defineProperty(exports, "useConversationCall", { enumerable: true, get: function () { return useConversationCall_1.useConversationCall; } });
Object.defineProperty(exports, "callingLabel", { enumerable: true, get: function () { return useConversationCall_1.callingLabel; } });
var useIncomingConversationCalls_1 = require("./useIncomingConversationCalls");
Object.defineProperty(exports, "useIncomingConversationCalls", { enumerable: true, get: function () { return useIncomingConversationCalls_1.useIncomingConversationCalls; } });
Object.defineProperty(exports, "parseConversationInvite", { enumerable: true, get: function () { return useIncomingConversationCalls_1.parseConversationInvite; } });
var conversationCallDockProps_1 = require("./conversationCallDockProps");
Object.defineProperty(exports, "conversationCallDockProps", { enumerable: true, get: function () { return conversationCallDockProps_1.conversationCallDockProps; } });
Object.defineProperty(exports, "DOCK_PHASE", { enumerable: true, get: function () { return conversationCallDockProps_1.DOCK_PHASE; } });
var useDevicePreferences_1 = require("./useDevicePreferences");
Object.defineProperty(exports, "useDevicePreferences", { enumerable: true, get: function () { return useDevicePreferences_1.useDevicePreferences; } });
Object.defineProperty(exports, "readDevicePreferences", { enumerable: true, get: function () { return useDevicePreferences_1.readDevicePreferences; } });
Object.defineProperty(exports, "deviceConstraints", { enumerable: true, get: function () { return useDevicePreferences_1.deviceConstraints; } });
Object.defineProperty(exports, "DEVICE_PREFERENCES_KEY", { enumerable: true, get: function () { return useDevicePreferences_1.DEVICE_PREFERENCES_KEY; } });
var conversationLobby_1 = require("./conversationLobby");
Object.defineProperty(exports, "dmLobbyName", { enumerable: true, get: function () { return conversationLobby_1.dmLobbyName; } });
Object.defineProperty(exports, "channelForLobby", { enumerable: true, get: function () { return conversationLobby_1.channelForLobby; } });
Object.defineProperty(exports, "lobbyForChannel", { enumerable: true, get: function () { return conversationLobby_1.lobbyForChannel; } });
Object.defineProperty(exports, "isDmLobby", { enumerable: true, get: function () { return conversationLobby_1.isDmLobby; } });
var documentCallTypes_1 = require("./documentCallTypes");
Object.defineProperty(exports, "DEFAULT_AUDIO_VIDEO_SETTINGS", { enumerable: true, get: function () { return documentCallTypes_1.DEFAULT_AUDIO_VIDEO_SETTINGS; } });
// Transport re-exports for advanced consumers (custom WHIP retry loops,
// SSR-shimmed fetch in tests). The hooks above own the common path.
var transport_1 = require("./lib/transport");
Object.defineProperty(exports, "whipPublish", { enumerable: true, get: function () { return transport_1.whipPublish; } });
Object.defineProperty(exports, "whepPublish", { enumerable: true, get: function () { return transport_1.whepPublish; } });
Object.defineProperty(exports, "fetchIceServers", { enumerable: true, get: function () { return transport_1.fetchIceServers; } });
Object.defineProperty(exports, "resolveResourceLocation", { enumerable: true, get: function () { return transport_1.resolveResourceLocation; } });
Object.defineProperty(exports, "LVSApiError", { enumerable: true, get: function () { return transport_1.LVSApiError; } });
var jwt_1 = require("./lib/jwt");
Object.defineProperty(exports, "decodeJwt", { enumerable: true, get: function () { return jwt_1.decodeJwt; } });
Object.defineProperty(exports, "decodeArn", { enumerable: true, get: function () { return jwt_1.decodeArn; } });
var sdp_1 = require("./lib/sdp");
Object.defineProperty(exports, "waitForIceGather", { enumerable: true, get: function () { return sdp_1.waitForIceGather; } });
Object.defineProperty(exports, "formatBitrate", { enumerable: true, get: function () { return sdp_1.formatBitrate; } });
Object.defineProperty(exports, "classifyNetQ", { enumerable: true, get: function () { return sdp_1.classifyNetQ; } });
//# sourceMappingURL=index.js.map