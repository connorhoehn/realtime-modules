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

import type { FeatureManifest } from '../feature-manifest/types';
import type { WsHandlerHandle, WsHandlerOptions } from '../server-ws/types';
import { createWsHandler } from '../server-ws/createWsHandler';
import { InMemoryChatStore, type ChatStore } from '../chat/ChatStore';
import { InMemoryActivityHistoryStore, type ActivityHistoryStore } from '../activity/ActivityHistoryStore';

// ---- AdapterMap ----------------------------------------------------------------

/**
 * All pluggable backends a feature might need. Pass real implementations for
 * production; call `inMemoryAdapters()` for zero-config dev / testing.
 *
 * All fields are optional — `inMemoryAdapters()` fills every one with an
 * in-memory fallback, and individual service factories fall back to their
 * own built-in in-memory defaults when a field is absent.
 */
export interface AdapterMap {
    /**
     * Backing store for persisted chat messages. When absent, ChatService
     * falls back to its built-in InMemoryChatStore.
     */
    chatStore?: ChatStore;

    /**
     * Backing store for activity-feed history. When absent, ActivityService
     * falls back to its built-in InMemoryActivityHistoryStore.
     */
    activityHistoryStore?: ActivityHistoryStore;
}

// ---- PerFeatureAdapters -------------------------------------------------------

/**
 * Alternate adapter configuration form that groups adapters by feature.
 * Use this when you only want to override adapters for specific features
 * and leave others at their defaults.
 *
 * @example
 * createRealtimeServer([ChatManifest], {
 *   chat: { store: myRedisChatStore },
 * }, { server: httpServer });
 */
export interface PerFeatureAdapters {
    /** Adapters for the chat feature. */
    chat?: {
        /** Backing store for persisted chat messages. */
        store?: ChatStore;
    };
    /** Adapters for the activity feature. */
    activity?: {
        /** Backing store for activity-feed history. */
        historyStore?: ActivityHistoryStore;
    };
    // Other features (presence, cursor, reactions, etc.) have no
    // configurable adapters at this level.
}

/**
 * Either a flat `AdapterMap` (legacy / `inMemoryAdapters()` form) or a
 * per-feature `PerFeatureAdapters` object.
 *
 * At runtime the factory normalises both into an `AdapterMap` before
 * passing to service factories — so existing callers are unaffected.
 */
export type AdapterConfig = AdapterMap | PerFeatureAdapters;

// ---- resolveAdapters ----------------------------------------------------------

/**
 * Normalise an `AdapterConfig` (either flat or per-feature) into the flat
 * `AdapterMap` that the service factories consume.
 *
 * Detection heuristic: if the object has a `chatStore` or
 * `activityHistoryStore` key it is already a flat `AdapterMap`; otherwise
 * it is treated as `PerFeatureAdapters`.
 */
function resolveAdapters(config: AdapterConfig): AdapterMap {
    if ('chatStore' in config || 'activityHistoryStore' in config) {
        // Already a flat AdapterMap.
        return config as AdapterMap;
    }
    // PerFeatureAdapters form — map to flat.
    const pfa = config as PerFeatureAdapters;
    return {
        chatStore: pfa.chat?.store,
        activityHistoryStore: pfa.activity?.historyStore,
    };
}

// ---- FeaturePlugin ------------------------------------------------------------

/**
 * Lifecycle hook interface. Implement any subset of hooks; the router calls
 * each registered plugin in array order. All calls are fire-and-forget —
 * errors are logged with `console.error` but never propagate to callers.
 */
export interface FeaturePlugin {
    /** Optional name for logging / debugging. */
    name?: string;

    /** Called when a client subscribes to a channel. */
    onConnect?(ctx: { clientId: string; channelId: string }): void | Promise<void>;

    /**
     * Called when a client disconnects (unsubscribes from all channels).
     * `channels` is the full list of channels the client was in.
     */
    onDisconnect?(ctx: { clientId: string; channels: string[] }): void | Promise<void>;

    /**
     * Called before a message is fanned out to a channel.
     * `clientId` is the sender; if the send originates from the server
     * (no excludeClientId) it is set to `'server'`.
     */
    onMessage?(ctx: { clientId: string; channelId: string; message: unknown }): void | Promise<void>;
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
export function inMemoryAdapters(): AdapterMap {
    return {
        chatStore: new InMemoryChatStore(),
        activityHistoryStore: new InMemoryActivityHistoryStore(),
    };
}

// ---- Local in-memory message router -------------------------------------------

/**
 * Fire-and-forget helper: calls `fn` and swallows any error (logging it).
 */
function firePlugin(pluginName: string | undefined, fn: () => void | Promise<void>): void {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            result.then(undefined, (err: unknown) => {
                console.error(`[realtime-modules] plugin${pluginName ? ` "${pluginName}"` : ''} error:`, err);
            });
        }
    } catch (err) {
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
    private readonly channelMembers = new Map<string, Set<string>>();
    /** clientId → Set<channel> — mirror for disconnect notification */
    private readonly clientChannels = new Map<string, Set<string>>();
    /** Lazy reference — set by createRealtimeServer after handler creation. */
    private handleRef: WsHandlerHandle | null = null;
    /** Registered lifecycle plugins. */
    private readonly plugins: FeaturePlugin[];

    readonly redisAvailable = false;
    readonly nodeId = 'local';

    constructor(plugins: FeaturePlugin[] = []) {
        this.plugins = plugins;
    }

    _setHandle(handle: WsHandlerHandle): void {
        this.handleRef = handle;
    }

    sendToClient(clientId: string, message: unknown): void {
        if (!this.handleRef) return; // pre-connection, no-op
        this.handleRef.sendToClient(clientId, message as Record<string, unknown>);
    }

    sendToLocalClient(clientId: string, message: unknown): void {
        this.sendToClient(clientId, message);
    }

    async sendToChannel(
        channel: string,
        message: unknown,
        excludeClientId?: string,
    ): Promise<void> {
        // Fire onMessage for each plugin before fan-out.
        const senderId = excludeClientId ?? 'server';
        for (const plugin of this.plugins) {
            if (plugin.onMessage) {
                firePlugin(plugin.name, () =>
                    plugin.onMessage!({ clientId: senderId, channelId: channel, message }),
                );
            }
        }

        const members = this.channelMembers.get(channel);
        if (!members || members.size === 0) return;
        for (const clientId of members) {
            if (clientId !== excludeClientId) {
                this.sendToClient(clientId, message);
            }
        }
    }

    subscribeToChannel(clientId: string, channel: string): void {
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
                firePlugin(plugin.name, () =>
                    plugin.onConnect!({ clientId, channelId: channel }),
                );
            }
        }
    }

    unsubscribeFromChannel(clientId: string, channel: string): void {
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
                        firePlugin(plugin.name, () =>
                            plugin.onDisconnect!({ clientId, channels: [channel] }),
                        );
                    }
                }
            }
        }
    }

    /**
     * Called when the WebSocket connection closes. Removes the client from all
     * channel memberships and fires `onDisconnect` with the full channel list.
     */
    removeClient(clientId: string): void {
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
                    firePlugin(plugin.name, () =>
                        plugin.onDisconnect!({ clientId, channels: channelList }),
                    );
                }
            }
        }
    }

    getClientData(_clientId: string): null {
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

type ServiceFactory = (
    router: LocalMessageRouter,
    adapters: AdapterMap,
) => import('../server-ws/types').WsService;

/**
 * Registry mapping manifest.name → service factory.
 * When a feature manifest appears in the `features` array, its factory is
 * called to instantiate the service. Unknown names are silently skipped.
 */
const FEATURE_REGISTRY: Record<string, ServiceFactory> = {
    chat: (router, adapters) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ChatService } = require('../chat/ChatService') as typeof import('../chat/ChatService');
        return new ChatService({
            messageRouter: router,
            logger: NOOP_LOGGER,
            chatStore: adapters.chatStore,
        });
    },

    presence: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const PresenceService = require('../presence/PresenceService') as typeof import('../presence/PresenceService');
        const Svc = (PresenceService as any).default ?? PresenceService;
        return new Svc(router, NOOP_LOGGER, {
            // Speed up sweeps in tests / dev so timers don't linger.
            heartbeatIntervalMs: 30_000,
            cleanupIntervalMs: 30_000,
            disconnectDelayMs: 5_000,
        });
    },

    cursor: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { CursorService } = require('../cursor/CursorService') as typeof import('../cursor/CursorService');
        return new CursorService({ messageRouter: router, logger: NOOP_LOGGER });
    },

    reactions: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ReactionService } = require('../reactions/ReactionService') as typeof import('../reactions/ReactionService');
        return new ReactionService({ messageRouter: router, logger: NOOP_LOGGER });
    },

    activity: (router, adapters) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ActivityService } = require('../activity/ActivityService') as typeof import('../activity/ActivityService');
        return new ActivityService({
            messageRouter: router,
            logger: NOOP_LOGGER,
            historyStore: adapters.activityHistoryStore,
        });
    },

    social: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { SocialService } = require('../social/SocialService') as typeof import('../social/SocialService');
        return new SocialService({ messageRouter: router, logger: NOOP_LOGGER });
    },

    call: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { CallService } = require('../call/CallService') as typeof import('../call/CallService');
        // LocalMessageRouter does not implement broadcastToAll / getClientsByUserId.
        // Wrap it with minimal stubs; broadcast and targeted routing degrade
        // gracefully (no-op) in local/dev mode where there are no other connected
        // users to route to.
        const callRouter = {
            sendToClient: (clientId: string, msg: unknown) => router.sendToClient(clientId, msg),
            broadcastToAll: async (_msg: unknown, _excludeId: string): Promise<void> => { /* local no-op */ },
            getClientsByUserId: (_userIds: string[], _excludeId: string) => [] as { clientId: string; userId: string }[],
        };
        return new CallService({ messageRouter: callRouter, logger: NOOP_LOGGER });
    },

    ingest: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { IngestService } = require('../ingest/IngestService') as typeof import('../ingest/IngestService');
        return new IngestService({ messageRouter: router, logger: NOOP_LOGGER });
    },

    pipeline: (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { PipelineWsRouter } = require('../pipeline/PipelineWsRouter') as typeof import('../pipeline/PipelineWsRouter');
        return new PipelineWsRouter({ messageRouter: router, logger: NOOP_LOGGER });
    },

    'typed-documents': (router) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DocumentEventsService } = require('../typed-documents/DocumentEventsService') as typeof import('../typed-documents/DocumentEventsService');
        return new DocumentEventsService({ messageRouter: router, logger: NOOP_LOGGER });
    },
};

// ---- createRealtimeServer ----------------------------------------------------

/**
 * Options for createRealtimeServer. Merges WsHandlerOptions (minus `services`,
 * which the factory builds from `features`) with feature/adapter config.
 */
export interface RealtimeServerOptions extends Omit<WsHandlerOptions, 'services'> {
    /**
     * Optional lifecycle plugins. Each plugin's hooks are called in array
     * order. Calls are fire-and-forget — errors are logged but never
     * propagate to the caller.
     */
    plugins?: FeaturePlugin[];
}

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
export function createRealtimeServer(
    features: FeatureManifest[],
    adapters: AdapterConfig = {},
    opts: RealtimeServerOptions,
): WsHandlerHandle {
    const { plugins = [], ...wsOpts } = opts;
    const router = new LocalMessageRouter(plugins);

    // Normalise AdapterConfig → flat AdapterMap for the service factories.
    const flatAdapters = resolveAdapters(adapters);

    // Instantiate one service per recognised feature manifest name.
    const services: Record<string, import('../server-ws/types').WsService> = {};
    for (const manifest of features) {
        const factory = FEATURE_REGISTRY[manifest.name];
        if (!factory) continue; // unknown feature — skip silently
        services[manifest.name] = factory(router, flatAdapters);
    }

    // Compose onDisconnect: call the consumer's hook first, then removeClient.
    const consumerOnDisconnect = wsOpts.onDisconnect;
    const composedOnDisconnect = (clientId: string): void => {
        try { consumerOnDisconnect?.(clientId); } catch { /* swallow */ }
        router.removeClient(clientId);
    };

    // Build the handler. At this point `router.handleRef` is still null —
    // services must not call sendToClient during construction (they don't).
    const handle = createWsHandler({
        ...wsOpts,
        services,
        onDisconnect: composedOnDisconnect,
    });

    // Now wire the handle into the router so sendToClient works at runtime.
    router._setHandle(handle);

    return handle;
}
