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
import type { WsHandlerHandle, WsHandlerOptions, WsHttpServer } from '../server-ws/types';
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
 * A deferred-handle router that:
 *   - Tracks per-client channel subscriptions in a Map<clientId, Set<channel>>.
 *   - Fans out sendToChannel to all clients subscribed to that channel.
 *   - Forwards sendToClient through the WsHandlerHandle (resolved lazily).
 *
 * `redisAvailable: false` tells services not to warn about Redis absence.
 */
class LocalMessageRouter {
    /** channel → Set<clientId> */
    private readonly channelMembers = new Map<string, Set<string>>();
    /** Lazy reference — set by createRealtimeServer after handler creation. */
    private handleRef: WsHandlerHandle | null = null;

    readonly redisAvailable = false;
    readonly nodeId = 'local';

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
        const members = this.channelMembers.get(channel);
        if (!members || members.size === 0) return;
        for (const clientId of members) {
            if (clientId !== excludeClientId) {
                this.sendToClient(clientId, message);
            }
        }
    }

    subscribeToChannel(clientId: string, channel: string): void {
        let members = this.channelMembers.get(channel);
        if (!members) {
            members = new Set();
            this.channelMembers.set(channel, members);
        }
        members.add(clientId);
    }

    unsubscribeFromChannel(clientId: string, channel: string): void {
        const members = this.channelMembers.get(channel);
        if (!members) return;
        members.delete(clientId);
        if (members.size === 0) {
            this.channelMembers.delete(channel);
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
export type RealtimeServerOptions = Omit<WsHandlerOptions, 'services'>;

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
export function createRealtimeServer(
    features: FeatureManifest[],
    adapters: Partial<AdapterMap> = {},
    opts: RealtimeServerOptions,
): WsHandlerHandle {
    const router = new LocalMessageRouter();

    // Instantiate one service per recognised feature manifest name.
    const services: Record<string, import('../server-ws/types').WsService> = {};
    for (const manifest of features) {
        const factory = FEATURE_REGISTRY[manifest.name];
        if (!factory) continue; // unknown feature — skip silently
        services[manifest.name] = factory(router, adapters as AdapterMap);
    }

    // Build the handler. At this point `router.handleRef` is still null —
    // services must not call sendToClient during construction (they don't).
    const handle = createWsHandler({ ...opts, services });

    // Now wire the handle into the router so sendToClient works at runtime.
    router._setHandle(handle);

    return handle;
}
