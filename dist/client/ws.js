"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDocumentHidden = exports.useDocumentHidden = exports.useSharedSocket = exports.SharedSocketProvider = exports.useLiveRefresh = exports.MAX_LIVE_REFRESH_BACKOFF = exports.DEFAULT_LIVE_REFRESH_LIVE_POLL_MS = exports.DEFAULT_LIVE_REFRESH_POLL_MS = exports.liveRefreshDelay = exports.createLiveRefresh = exports.useSharedWebSocket = exports.useSharedSocketTransport = exports.defaultChannelService = exports.createSharedSocketTransport = exports.useFeatures = exports.useGateway = exports.GatewaySocketProvider = exports.useWebSocket = void 0;
// Non-CRDT WebSocket surface — safe to import without yjs / y-protocols.
// Use this subpath (./client/ws) when you only need useWebSocket and its
// types. The ./client barrel re-exports GatewayProvider which has a hard
// yjs/y-protocols dependency; consumers that don't use CRDT must not import
// from ./client directly.
//
// GatewaySocketProvider is included here because it only depends on
// useWebSocket (no yjs / y-protocols imports) and is the recommended
// zero-config way to wire the WS connection in React apps.
var useWebSocket_1 = require("./useWebSocket");
Object.defineProperty(exports, "useWebSocket", { enumerable: true, get: function () { return useWebSocket_1.useWebSocket; } });
var GatewaySocketProvider_1 = require("./GatewaySocketProvider");
Object.defineProperty(exports, "GatewaySocketProvider", { enumerable: true, get: function () { return GatewaySocketProvider_1.GatewaySocketProvider; } });
Object.defineProperty(exports, "useGateway", { enumerable: true, get: function () { return GatewaySocketProvider_1.useGateway; } });
Object.defineProperty(exports, "useFeatures", { enumerable: true, get: function () { return GatewaySocketProvider_1.useFeatures; } });
// v0.144.0 — one host-owned socket shared by several consumers: fan-out of
// inbound frames, refcounted channel subscriptions, re-subscription per
// session epoch, and adapters for the pipeline hooks' `transport` and
// ui-components' EventStreamProvider `channelTransport`.
var sharedSocketTransport_1 = require("./sharedSocketTransport");
Object.defineProperty(exports, "createSharedSocketTransport", { enumerable: true, get: function () { return sharedSocketTransport_1.createSharedSocketTransport; } });
Object.defineProperty(exports, "defaultChannelService", { enumerable: true, get: function () { return sharedSocketTransport_1.defaultChannelService; } });
var useSharedSocketTransport_1 = require("./useSharedSocketTransport");
Object.defineProperty(exports, "useSharedSocketTransport", { enumerable: true, get: function () { return useSharedSocketTransport_1.useSharedSocketTransport; } });
Object.defineProperty(exports, "useSharedWebSocket", { enumerable: true, get: function () { return useSharedSocketTransport_1.useSharedWebSocket; } });
// v0.145.0 — live refresh: a frame is a hint that re-reads the record
// (coalesced, one read in flight + one queued), polling when the socket is
// down or the channel refused, paused while hidden. Plus the provider that
// keeps the shared transport in context (non-null while disconnected).
var liveRefresh_1 = require("./liveRefresh");
Object.defineProperty(exports, "createLiveRefresh", { enumerable: true, get: function () { return liveRefresh_1.createLiveRefresh; } });
Object.defineProperty(exports, "liveRefreshDelay", { enumerable: true, get: function () { return liveRefresh_1.liveRefreshDelay; } });
Object.defineProperty(exports, "DEFAULT_LIVE_REFRESH_POLL_MS", { enumerable: true, get: function () { return liveRefresh_1.DEFAULT_LIVE_REFRESH_POLL_MS; } });
Object.defineProperty(exports, "DEFAULT_LIVE_REFRESH_LIVE_POLL_MS", { enumerable: true, get: function () { return liveRefresh_1.DEFAULT_LIVE_REFRESH_LIVE_POLL_MS; } });
Object.defineProperty(exports, "MAX_LIVE_REFRESH_BACKOFF", { enumerable: true, get: function () { return liveRefresh_1.MAX_LIVE_REFRESH_BACKOFF; } });
var useLiveRefresh_1 = require("./useLiveRefresh");
Object.defineProperty(exports, "useLiveRefresh", { enumerable: true, get: function () { return useLiveRefresh_1.useLiveRefresh; } });
var SharedSocketProvider_1 = require("./SharedSocketProvider");
Object.defineProperty(exports, "SharedSocketProvider", { enumerable: true, get: function () { return SharedSocketProvider_1.SharedSocketProvider; } });
Object.defineProperty(exports, "useSharedSocket", { enumerable: true, get: function () { return SharedSocketProvider_1.useSharedSocket; } });
var useDocumentHidden_1 = require("./useDocumentHidden");
Object.defineProperty(exports, "useDocumentHidden", { enumerable: true, get: function () { return useDocumentHidden_1.useDocumentHidden; } });
Object.defineProperty(exports, "isDocumentHidden", { enumerable: true, get: function () { return useDocumentHidden_1.isDocumentHidden; } });
//# sourceMappingURL=ws.js.map