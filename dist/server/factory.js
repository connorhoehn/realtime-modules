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
// ---- resolveAdapters ----------------------------------------------------------
/**
 * Normalise an `AdapterConfig` (either flat or per-feature) into the flat
 * `AdapterMap` that the service factories consume.
 *
 * Detection heuristic: if the object has a `chatStore` or
 * `activityHistoryStore` key it is already a flat `AdapterMap`; otherwise
 * it is treated as `PerFeatureAdapters`.
 */
function resolveAdapters(config) {
    if ('chatStore' in config || 'activityHistoryStore' in config) {
        // Already a flat AdapterMap.
        return config;
    }
    // PerFeatureAdapters form — map to flat.
    const pfa = config;
    return {
        chatStore: pfa.chat?.store,
        activityHistoryStore: pfa.activity?.historyStore,
    };
}
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
 * Fire-and-forget helper: calls `fn` and swallows any error (logging it).
 */
function firePlugin(pluginName, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            result.then(undefined, (err) => {
                console.error(`[realtime-modules] plugin${pluginName ? ` "${pluginName}"` : ''} error:`, err);
            });
        }
    }
    catch (err) {
        console.error(`[realtime-modules] plugin${pluginName ? ` "${pluginName}"` : ''} error:`, err);
    }
}
/**
 * A deferred-handle router that:
 *   - Tracks per-client channel subscriptions in a Map<clientId, Set<channel>>.
 *   - Fans out sendToChannel to all clients subscribed to that channel.
 *   - Forwards sendToClient through the WsHandlerHandle (resolved lazily).
 *   - Calls registered FeaturePlugin hooks (fire-and-forget, errors swallowed).
 *
 * `redisAvailable: false` tells services not to warn about Redis absence.
 */
class LocalMessageRouter {
    /** channel → Set<clientId> */
    channelMembers = new Map();
    /** clientId → Set<channel> — mirror for disconnect notification */
    clientChannels = new Map();
    /** Lazy reference — set by createRealtimeServer after handler creation. */
    handleRef = null;
    /** Registered lifecycle plugins. */
    plugins;
    redisAvailable = false;
    nodeId = 'local';
    constructor(plugins = []) {
        this.plugins = plugins;
    }
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
        // Fire onMessage for each plugin before fan-out.
        const senderId = excludeClientId ?? 'server';
        for (const plugin of this.plugins) {
            if (plugin.onMessage) {
                firePlugin(plugin.name, () => plugin.onMessage({ clientId: senderId, channelId: channel, message }));
            }
        }
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
        // Update channel → clients index.
        let members = this.channelMembers.get(channel);
        if (!members) {
            members = new Set();
            this.channelMembers.set(channel, members);
        }
        members.add(clientId);
        // Update client → channels index.
        let channels = this.clientChannels.get(clientId);
        if (!channels) {
            channels = new Set();
            this.clientChannels.set(clientId, channels);
        }
        channels.add(channel);
        // Fire onConnect for each plugin.
        for (const plugin of this.plugins) {
            if (plugin.onConnect) {
                firePlugin(plugin.name, () => plugin.onConnect({ clientId, channelId: channel }));
            }
        }
    }
    unsubscribeFromChannel(clientId, channel) {
        const members = this.channelMembers.get(channel);
        if (members) {
            members.delete(clientId);
            if (members.size === 0) {
                this.channelMembers.delete(channel);
            }
        }
        const channels = this.clientChannels.get(clientId);
        if (channels) {
            channels.delete(channel);
            if (channels.size === 0) {
                this.clientChannels.delete(clientId);
                // All channels gone — fire onDisconnect.
                for (const plugin of this.plugins) {
                    if (plugin.onDisconnect) {
                        firePlugin(plugin.name, () => plugin.onDisconnect({ clientId, channels: [channel] }));
                    }
                }
            }
        }
    }
    /**
     * Called when the WebSocket connection closes. Removes the client from all
     * channel memberships and fires `onDisconnect` with the full channel list.
     */
    removeClient(clientId) {
        const channels = this.clientChannels.get(clientId);
        const channelList = channels ? [...channels] : [];
        // Clean up reverse index.
        for (const channel of channelList) {
            const members = this.channelMembers.get(channel);
            if (members) {
                members.delete(clientId);
                if (members.size === 0) {
                    this.channelMembers.delete(channel);
                }
            }
        }
        this.clientChannels.delete(clientId);
        // Only fire onDisconnect if the client was actually in channels.
        if (channelList.length > 0) {
            for (const plugin of this.plugins) {
                if (plugin.onDisconnect) {
                    firePlugin(plugin.name, () => plugin.onDisconnect({ clientId, channels: channelList }));
                }
            }
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
    social: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { SocialService } = require('../social/SocialService');
        return new SocialService({ messageRouter: router, logger: NOOP_LOGGER });
    },
    call: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { CallService } = require('../call/CallService');
        // LocalMessageRouter does not implement broadcastToAll / getClientsByUserId.
        // Wrap it with minimal stubs; broadcast and targeted routing degrade
        // gracefully (no-op) in local/dev mode where there are no other connected
        // users to route to.
        const callRouter = {
            sendToClient: (clientId, msg) => router.sendToClient(clientId, msg),
            broadcastToAll: async (_msg, _excludeId) => { },
            getClientsByUserId: (_userIds, _excludeId) => [],
        };
        return new CallService({ messageRouter: callRouter, logger: NOOP_LOGGER });
    },
    ingest: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { IngestService } = require('../ingest/IngestService');
        return new IngestService({ messageRouter: router, logger: NOOP_LOGGER });
    },
    pipeline: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PipelineWsRouter } = require('../pipeline/PipelineWsRouter');
        return new PipelineWsRouter({ messageRouter: router, logger: NOOP_LOGGER });
    },
    room: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { RoomService } = require('../room/RoomService');
        return new RoomService({ messageRouter: router, logger: NOOP_LOGGER });
    },
    notification: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { NotificationService } = require('../notification/NotificationService');
        return new NotificationService({ messageRouter: router, logger: NOOP_LOGGER, redisClient: null });
    },
    fileupload: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { FileUploadService } = require('../fileupload/FileUploadService');
        return new FileUploadService({ messageRouter: router, logger: NOOP_LOGGER });
    },
    'typed-documents': (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DocumentEventsService } = require('../typed-documents/DocumentEventsService');
        return new DocumentEventsService({ messageRouter: router, logger: NOOP_LOGGER });
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
 * @param adapters  Storage backends. Either a flat `AdapterMap` (or the result
 *                  of `inMemoryAdapters()`) or a `PerFeatureAdapters` object.
 *                  Pass `inMemoryAdapters()` for dev/tests, or provide real
 *                  implementations for production.
 * @param opts      WsHandlerOptions (minus `services`). `server` is required.
 *                  Optionally include `plugins` for lifecycle hooks.
 */
function createRealtimeServer(features, adapters = {}, opts) {
    const { plugins = [], ...wsOpts } = opts;
    const router = new LocalMessageRouter(plugins);
    // Normalise AdapterConfig → flat AdapterMap for the service factories.
    const flatAdapters = resolveAdapters(adapters);
    // Instantiate one service per recognised feature manifest name.
    const services = {};
    for (const manifest of features) {
        const factory = FEATURE_REGISTRY[manifest.name];
        if (!factory)
            continue; // unknown feature — skip silently
        services[manifest.name] = factory(router, flatAdapters);
    }
    // Compose onDisconnect: call the consumer's hook first, then removeClient.
    const consumerOnDisconnect = wsOpts.onDisconnect;
    const composedOnDisconnect = (clientId) => {
        try {
            consumerOnDisconnect?.(clientId);
        }
        catch { /* swallow */ }
        router.removeClient(clientId);
    };
    // Build the handler. At this point `router.handleRef` is still null —
    // services must not call sendToClient during construction (they don't).
    const handle = (0, createWsHandler_1.createWsHandler)({
        ...wsOpts,
        services,
        onDisconnect: composedOnDisconnect,
    });
    // Now wire the handle into the router so sendToClient works at runtime.
    router._setHandle(handle);
    return handle;
}
//# sourceMappingURL=factory.js.map