"use strict";
// realtime-modules/src/server/factory.ts
//
// Zero-config factory for spinning up a fully-wired realtime WS server.
//
// Goal: a new Express + WS project should be able to get a working realtime
// server in < 10 lines, without manually instantiating each service or
// wiring a message router.
//
// Usage:
//
//   import http from 'http';
//   import express from 'express';
//   import {
//     createRealtimeServer,
//     inMemoryAdapters,
//   } from '@connorhoehn/realtime-modules/server';
//   import { ChatManifest } from '@connorhoehn/realtime-modules/chat';
//   import { PresenceManifest } from '@connorhoehn/realtime-modules/presence';
//
//   const app = express();
//   const httpServer = http.createServer(app);
//
//   createRealtimeServer([ChatManifest, PresenceManifest], inMemoryAdapters(), {
//     server: httpServer,
//   });
//
//   httpServer.listen(3000);
//
// Design notes:
//
//   - Each feature manifest has a `name` field (e.g. 'chat', 'presence')
//     that maps to a service factory registered in FEATURE_REGISTRY below.
//     Manifests for unknown features are silently skipped.
//
//   - Services need a `messageRouter.sendToClient` — but that lives on the
//     WsHandlerHandle returned by createWsHandler, which is created last.
//     We solve this with a deferred-reference router: the router's
//     sendToClient is a thunk over a handle ref set after creation.
//
//   - The in-memory router's sendToChannel fans out to all locally-tracked
//     subscribers (no Redis, no pubsub). Suitable for single-process dev /
//     testing only.
//
//   - For production, pass real adapter implementations (Redis-backed
//     ChatStore, presence MessageRouter, etc.) via AdapterMap.
Object.defineProperty(exports, "__esModule", { value: true });
exports.inMemoryAdapters = inMemoryAdapters;
exports.createRealtimeServer = createRealtimeServer;
const createWsHandler_1 = require("../server-ws/createWsHandler");
const ChatStore_1 = require("../chat/ChatStore");
const ActivityHistoryStore_1 = require("../activity/ActivityHistoryStore");
// ---- inMemoryAdapters ---------------------------------------------------------
/**
 * Returns an `AdapterMap` backed entirely by in-process Maps — no external
 * services (Redis, DynamoDB) required.
 *
 * Intended for:
 *   - local development without docker-compose
 *   - unit / integration tests
 *   - embedded apps that don't need durable storage
 */
function inMemoryAdapters() {
    return {
        chatStore: new ChatStore_1.InMemoryChatStore(),
        activityHistoryStore: new ActivityHistoryStore_1.InMemoryActivityHistoryStore(),
    };
}
// ---- Local in-memory message router -------------------------------------------
/**
 * A deferred-handle router that:
 *   - Tracks per-client channel subscriptions in a Map<clientId, Set<channel>>.
 *   - Fans out sendToChannel to all clients subscribed to that channel.
 *   - Forwards sendToClient through the WsHandlerHandle (resolved lazily).
 *
 * `redisAvailable: false` tells services not to warn about Redis absence.
 */
class LocalMessageRouter {
    /** channel → Set<clientId> */
    channelMembers = new Map();
    /** Lazy reference — set by createRealtimeServer after handler creation. */
    handleRef = null;
    redisAvailable = false;
    nodeId = 'local';
    _setHandle(handle) {
        this.handleRef = handle;
    }
    sendToClient(clientId, message) {
        if (!this.handleRef)
            return; // pre-connection, no-op
        this.handleRef.sendToClient(clientId, message);
    }
    sendToLocalClient(clientId, message) {
        this.sendToClient(clientId, message);
    }
    async sendToChannel(channel, message, excludeClientId) {
        const members = this.channelMembers.get(channel);
        if (!members || members.size === 0)
            return;
        for (const clientId of members) {
            if (clientId !== excludeClientId) {
                this.sendToClient(clientId, message);
            }
        }
    }
    subscribeToChannel(clientId, channel) {
        let members = this.channelMembers.get(channel);
        if (!members) {
            members = new Set();
            this.channelMembers.set(channel, members);
        }
        members.add(clientId);
    }
    unsubscribeFromChannel(clientId, channel) {
        const members = this.channelMembers.get(channel);
        if (!members)
            return;
        members.delete(clientId);
        if (members.size === 0) {
            this.channelMembers.delete(channel);
        }
    }
    getClientData(_clientId) {
        return null;
    }
}
// ---- Service factories --------------------------------------------------------
/**
 * Noop logger — used as the default when `opts.logger` is not supplied.
 * Keeps stdout clean in tests without forcing consumers to pass a logger.
 */
const NOOP_LOGGER = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
/**
 * Registry mapping manifest.name → service factory.
 * When a feature manifest appears in the `features` array, its factory is
 * called to instantiate the service. Unknown names are silently skipped.
 */
const FEATURE_REGISTRY = {
    chat: (router, adapters) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ChatService } = require('../chat/ChatService');
        return new ChatService({
            messageRouter: router,
            logger: NOOP_LOGGER,
            chatStore: adapters.chatStore,
        });
    },
    presence: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const PresenceService = require('../presence/PresenceService');
        const Svc = PresenceService.default ?? PresenceService;
        return new Svc(router, NOOP_LOGGER, {
            // Speed up sweeps in tests / dev so timers don't linger.
            heartbeatIntervalMs: 30_000,
            cleanupIntervalMs: 30_000,
            disconnectDelayMs: 5_000,
        });
    },
    cursor: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { CursorService } = require('../cursor/CursorService');
        return new CursorService({ messageRouter: router, logger: NOOP_LOGGER });
    },
    reactions: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ReactionService } = require('../reactions/ReactionService');
        return new ReactionService({ messageRouter: router, logger: NOOP_LOGGER });
    },
    activity: (router, adapters) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ActivityService } = require('../activity/ActivityService');
        return new ActivityService({
            messageRouter: router,
            logger: NOOP_LOGGER,
            historyStore: adapters.activityHistoryStore,
        });
    },
};
/**
 * Wire `features` + `adapters` into a ready-to-use WS handler.
 *
 * Returns the same `WsHandlerHandle` shape that `createWsHandler` returns:
 *   { wss, dispose(), listClients(), sendToClient() }
 *
 * Minimal example (10 lines):
 *
 *   const httpServer = http.createServer(app);
 *   const handle = createRealtimeServer(
 *     [ChatManifest, PresenceManifest],
 *     inMemoryAdapters(),
 *     { server: httpServer },
 *   );
 *   httpServer.listen(3000);
 *
 * @param features  Array of FeatureManifest objects — only manifests whose
 *                  `name` appears in the built-in registry are instantiated.
 *                  Unknown names are silently skipped.
 * @param adapters  Storage backends. Pass `inMemoryAdapters()` for dev/tests,
 *                  or provide real implementations for production.
 * @param opts      WsHandlerOptions (minus `services`). `server` is required.
 */
function createRealtimeServer(features, adapters = {}, opts) {
    const router = new LocalMessageRouter();
    // Instantiate one service per recognised feature manifest name.
    const services = {};
    for (const manifest of features) {
        const factory = FEATURE_REGISTRY[manifest.name];
        if (!factory)
            continue; // unknown feature — skip silently
        services[manifest.name] = factory(router, adapters);
    }
    // Build the handler. At this point `router.handleRef` is still null —
    // services must not call sendToClient during construction (they don't).
    const handle = (0, createWsHandler_1.createWsHandler)({ ...opts, services });
    // Now wire the handle into the router so sendToClient works at runtime.
    router._setHandle(handle);
    return handle;
}
//# sourceMappingURL=factory.js.map