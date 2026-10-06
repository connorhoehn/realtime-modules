// realtime-modules/src/server/attach.ts
//
// The pluggable-feature composition layer.
//
//   import http from 'http';
//   import { attachRealtime, chat, presence, rooms } from '@connorhoehn/realtime-modules/server';
//
//   const httpServer = http.createServer(app);   // your EXISTING app
//   const realtime = attachRealtime(httpServer, {
//       features: [chat(), presence(), rooms()],
//       auth: async (req) => ({ userId: await verify(req) }),
//   });
//   httpServer.listen(3000);
//
// Design principles (max extensibility):
//
//   1. THE REGISTRY IS OPEN. `defineFeature` is the public contract; the
//      thirteen built-ins below are ordinary calls of it, with no private
//      privileges. An app-defined feature #14 plugs in identically:
//
//        const scoreboard = defineFeature({
//            manifest: { name: 'scoreboard', version: '1.0.0', envVars: {}, channels: ['score:*'] },
//            create: ({ router, logger }) => new ScoreboardService(router, logger),
//        });
//        attachRealtime(server, { features: [chat(), scoreboard] });
//
//   2. FEATURES COMPOSE À LA CARTE. Every feature must work alone and in
//      any combination — enforced by the attach test matrix, not by
//      convention.
//
//   3. THE TRANSPORT IS SWAPPABLE. Features receive a `RealtimeRouter`;
//      the default is the in-process LocalRealtimeRouter, and a Redis/
//      multi-node router (the websocket-gateway pattern) drops in via
//      `opts.router` without touching any feature.
//
//   4. PER-FEATURE OPTIONS LIVE AT THE FEATURE CALLSITE (`chat({ store })`),
//      not in a central adapter map — adding a feature never means editing
//      a shared config type.

import type { FeatureManifest } from '../feature-manifest/types';
import type { WsHandlerHandle, WsHandlerOptions, WsService } from '../server-ws/types';
import { createWsHandler } from '../server-ws/createWsHandler';
import {
    LocalRealtimeRouter,
    type ChannelAuthorize,
    type ClientMessageFilter,
    type FeaturePlugin,
    type RealtimeRouter,
    type RouterLogger,
} from './router';
import { createSubscribeService } from './subscribeService';

// ---- feature contract ---------------------------------------------------------

/** Everything a feature's factory receives. */
export interface FeatureContext {
    /** The shared router — Local by default, swappable via attach opts. */
    router: RealtimeRouter;
    /** Logger shared by the whole attachment. */
    logger: RouterLogger;
}

/** A pluggable realtime capability: manifest + service factory. */
export interface RealtimeFeature {
    manifest: FeatureManifest;
    /**
     * Wire routing key — the `service` field clients put on their frames.
     * Defaults to `manifest.name`; set explicitly when the two differ
     * (the CRDT feature's manifest identity is 'document-sharing' but every
     * client hook addresses `service: 'crdt'`).
     */
    serviceName?: string;
    /** Instantiate the feature's WS service against the shared context. */
    create(ctx: FeatureContext): WsService;
}

/** Identity helper — exists so feature definitions type-check at the site. */
export function defineFeature(feature: RealtimeFeature): RealtimeFeature {
    return feature;
}

// ---- built-in features ----------------------------------------------------------

const NOOP_LOGGER: RouterLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

/* eslint-disable @typescript-eslint/no-var-requires */

export function chat(
    opts: Omit<import('../chat/ChatService').ChatServiceOpts, 'messageRouter' | 'logger' | 'chatStore'> & {
        /** @deprecated use `chatStore` — kept for backwards compatibility. */
        store?: import('../chat/ChatStore').ChatStore;
        chatStore?: import('../chat/ChatStore').ChatStore;
    } = {},
): RealtimeFeature {
    return defineFeature({
        manifest: require('../chat/manifest').ChatManifest,
        create: ({ router, logger }) => {
            const { ChatService } = require('../chat/ChatService') as typeof import('../chat/ChatService');
            const { store, chatStore, identityResolver, ...rest } = opts;
            return new ChatService({
                ...rest,
                messageRouter: router as any,
                logger: logger as any,
                chatStore: chatStore ?? store,
                // Default to the router's own identity accessor so chat
                // messages carry userId (enabling edit/delete/addMembers/
                // read receipts/DM enforcement) without every consumer
                // having to rewire it by hand.
                identityResolver: identityResolver ?? ((clientId: string) => {
                    const userId = router.getUserIdForClient?.(clientId);
                    return userId ? { userId } : null;
                }),
            });
        },
    });
}

export function presence(
    opts: import('../presence/types').PresenceConfig = {},
): RealtimeFeature {
    return defineFeature({
        manifest: require('../presence/manifest').PresenceManifest,
        create: ({ router, logger }) => {
            const PresenceService = require('../presence/PresenceService') as any;
            const Svc = PresenceService.default ?? PresenceService;
            // Forward the full config — including `authorizeChannel`, which
            // used to be unreachable through attachRealtime entirely — and
            // let PresenceService own its own field-by-field defaulting
            // (config value → env var → hard default). Previously this
            // factory hardcoded 30_000/30_000/5_000 for the three fields it
            // did pass, which shadowed the env-var fallback for anyone not
            // explicitly setting them.
            return new Svc(router as any, logger as any, opts);
        },
    });
}

export function cursor(
    opts: import('../cursor/types').CursorConfig = {},
): RealtimeFeature {
    return defineFeature({
        manifest: require('../cursor/manifest').CursorManifest,
        create: ({ router, logger }) => {
            const { CursorService } = require('../cursor/CursorService') as typeof import('../cursor/CursorService');
            return new CursorService({ messageRouter: router as any, logger: logger as any, config: opts });
        },
    });
}

export function reactions(
    opts: import('../reactions/types').ReactionConfig = {},
): RealtimeFeature {
    return defineFeature({
        manifest: require('../reactions/manifest').ReactionsManifest,
        // Wire key 'reaction', manifest identity 'reactions'. Clients address
        // the singular — useReactions sends it, and event-catalog declares
        // `client.reaction.*` as the canonical frame. Registering under the
        // manifest name meant every frame the hook sent came back
        // SERVICE_NOT_AVAILABLE, so reactions did not work through
        // attachRealtime at all.
        serviceName: 'reaction',
        create: ({ router, logger }) => {
            const { ReactionService } = require('../reactions/ReactionService') as typeof import('../reactions/ReactionService');
            const { identityResolver, ...rest } = opts;
            return new ReactionService({
                messageRouter: router as any,
                logger: logger as any,
                config: {
                    ...rest,
                    // Same default as chat(): stamp userId from the
                    // router's own identity accessor so reaction events
                    // carry a userId without every consumer rewiring it.
                    identityResolver: identityResolver ?? ((clientId: string) => {
                        const userId = router.getUserIdForClient?.(clientId);
                        return userId ? { userId } : null;
                    }),
                },
            });
        },
    });
}

/**
 * The activity feed. Secure by default (0.107): clients cannot `publish`
 * (`allowClientPublish`), connections are not auto-subscribed to the
 * tenant-blind `activity:broadcast` (`autoSubscribeBroadcast`), and
 * `getHistory` is answered only when the router's `checkChannel` admits a
 * `subscribe` of that channel — a router without `checkChannel` gets no
 * history. The server produces events with
 * `handle.services.activity.publish(channel, event)`, which writes that
 * channel's history and delivers `{ type: 'activity:event', channel, payload }`.
 */
export function activity(opts: {
    historyStore?: import('../activity/ActivityHistoryStore').ActivityHistoryStore;
    config?: import('../activity/types').ActivityEventConfig;
    /** Shorthand for `config.allowClientPublish`. Default false. */
    allowClientPublish?: boolean;
    /** Shorthand for `config.autoSubscribeBroadcast`. Default false. */
    autoSubscribeBroadcast?: boolean;
} = {}): RealtimeFeature {
    return defineFeature({
        manifest: require('../activity/manifest').ActivityManifest,
        create: ({ router, logger }) => {
            const { ActivityService } = require('../activity/ActivityService') as typeof import('../activity/ActivityService');
            return new ActivityService({
                messageRouter: router as any,
                logger: logger as any,
                historyStore: opts.historyStore,
                config: {
                    ...(opts.config ?? {}),
                    ...(opts.allowClientPublish !== undefined ? { allowClientPublish: opts.allowClientPublish } : {}),
                    ...(opts.autoSubscribeBroadcast !== undefined ? { autoSubscribeBroadcast: opts.autoSubscribeBroadcast } : {}),
                },
            });
        },
    });
}

export function social(
    opts: import('../social/types').SocialConfig = {},
): RealtimeFeature {
    return defineFeature({
        manifest: require('../social/manifest').SocialManifest,
        create: ({ router, logger }) => {
            const { SocialService } = require('../social/SocialService') as typeof import('../social/SocialService');
            return new SocialService({ messageRouter: router as any, logger: logger as any, config: opts });
        },
    });
}

export function calls(opts: {
    stateStore?: import('../call/CallStateStore').CallStateStore;
    config?: import('../call/types').CallConfig;
    /**
     * Refuse a lobby this connection may not use. Called with the gateway
     * `auth` result of the sender (`{ userId, …whatever your resolver
     * returned }`) and the frame's `lobbyName`, for every call frame that
     * names one. Return false and the frame is refused with an error, before
     * any routing. A tenant-scoped host checks the prefix:
     * `(auth, lobby) => lobby.startsWith(`${auth.org}:`)`. Default: allow.
     * Runs after `config.authorize` (both must pass).
     */
    lobbyGuard?: (auth: import('../server-ws/types').WsAuthContext, lobbyName: string) => boolean;
    /**
     * How long a call waits for someone whose socket dropped before it ends
     * (the rejoin grace). Default 30 s; 0 ends it at the drop.
     */
    rejoinGraceMs?: number;
    /**
     * Let an `invite` with no `targetUserIds` through. Default false: such an
     * invite is broadcast to every connected socket (every tenant's), so it
     * is refused with `{ type: 'error', service: 'call', code:
     * 'untargeted-invite', … }`. Room walk-ins (`room:` / `<tenant>:room:`
     * lobbies) and document-call invites are never refused.
     */
    allowUntargetedInvites?: boolean;
    /**
     * Cross-node pub/sub for call departures (`CallServiceOptions.crossNodePubSub`).
     * With more than one gateway node, a socket dropping on one node tells
     * the call's participants on the others (`user-status: left` / `ended`).
     * Single process: leave unset. It relays departures only — it is not a
     * cross-node router; rings and frames still need a router that reaches
     * every node (`attachRealtime({ router })`).
     */
    crossNodePubSub?: import('../call/types').CallCrossNodePubSub;
} = {}): RealtimeFeature {
    return defineFeature({
        manifest: require('../call/manifest').CallManifest,
        create: ({ router, logger }) => {
            const { CallService } = require('../call/CallService') as typeof import('../call/CallService');
            const { lobbyGuard } = opts;
            let config: import('../call/types').CallConfig = {
                ...(opts.config ?? {}),
                allowUntargetedInvites: opts.allowUntargetedInvites ?? opts.config?.allowUntargetedInvites ?? false,
            };
            if (lobbyGuard) {
                const inner = config?.authorize;
                config = {
                    ...config,
                    authorize: (clientId, action, data) => {
                        const guard = () => {
                            // Flat or nested (`{ data: { lobbyName } }`) — the service accepts both.
                            const nested = data && typeof data.data === 'object' && data.data ? data.data as { lobbyName?: unknown } : null;
                            const raw = data?.lobbyName ?? nested?.lobbyName;
                            const lobby = typeof raw === 'string' ? raw : '';
                            if (!lobby) return true;
                            const auth = router.getClientData?.(clientId)?.userContext ?? {};
                            try { return lobbyGuard(auth, lobby) !== false; } catch { return false; }
                        };
                        if (!inner) return guard();
                        try {
                            const decision = inner(clientId, action, data);
                            if (typeof decision === 'boolean') return decision && guard();
                            return Promise.resolve(decision).then(allowed => allowed === true && guard(), () => false);
                        } catch { return false; }
                    },
                };
            }
            return new CallService({
                messageRouter: router as any,
                logger: logger as any,
                stateStore: opts.stateStore,
                config,
                ...(typeof opts.rejoinGraceMs === 'number' ? { rejoinGraceMs: opts.rejoinGraceMs } : {}),
                ...(opts.crossNodePubSub ? { crossNodePubSub: opts.crossNodePubSub } : {}),
                ...(router.isClientAlive ? { isClientAlive: router.isClientAlive.bind(router) } : {}),
            });
        },
    });
}

export function ingest(
    opts: import('../ingest/types').IngestConfig = {},
): RealtimeFeature {
    return defineFeature({
        manifest: require('../ingest/manifest').IngestManifest,
        create: ({ router, logger }) => {
            const { IngestService } = require('../ingest/IngestService') as typeof import('../ingest/IngestService');
            return new IngestService({ messageRouter: router as any, logger: logger as any, config: opts });
        },
    });
}

/**
 * Pipeline run events. Clients subscribe `pipeline:run:<id>`; the cross-run
 * firehoses (`pipeline:all`, `pipeline:approvals`) are refused unless enabled
 * with `firehoses` (0.107). `channelFor(wire, { clientId, runId, userContext })`
 * maps a wire channel to the router channel actually subscribed (a tenant
 * partition), which the router's `authorize` then judges; producers emit to
 * that router channel through `handle.services.pipeline.emitEvent`.
 */
export function pipeline(
    opts: import('../pipeline/types').PipelineConfig = {},
): RealtimeFeature {
    return defineFeature({
        manifest: require('../pipeline/manifest').PipelineWsManifest,
        // Wire key 'pipeline', manifest identity 'pipeline-ws' — same split as
        // reactions and crdt. usePipelineRunStatus sends `service: 'pipeline'`.
        serviceName: 'pipeline',
        create: ({ router, logger }) => {
            const { PipelineWsRouter } = require('../pipeline/PipelineWsRouter') as typeof import('../pipeline/PipelineWsRouter');
            return new PipelineWsRouter({ messageRouter: router as any, logger: logger as any, config: opts });
        },
    });
}

/**
 * The work-graph stream behind `useWorkGraph` (0.108). Clients subscribe a
 * person-day from a snapshot cursor; `channelFor(scope, ctx)` maps it to a
 * router channel (absent or null refuses — default deny, no firehose) which
 * the router's `authorize` judges. Server-publish only: the host calls
 * `handle.services['work-graph'].publish(channel, change)` and its
 * `source.frames(sub, trigger)` computes each subscriber's own deltas from
 * that subscriber's cursor. See `WorkGraphStreamService`.
 */
export function workGraph(
    opts: import('../work-graph/streamService').WorkGraphStreamConfig = {},
): RealtimeFeature {
    return defineFeature({
        manifest: require('../work-graph/manifest').WorkGraphStreamManifest,
        create: ({ router, logger }) => {
            const { WorkGraphStreamService } = require('../work-graph/streamService') as typeof import('../work-graph/streamService');
            return new WorkGraphStreamService({ messageRouter: router as any, logger, config: opts });
        },
    });
}

export function typedDocuments(
    opts: import('../typed-documents/types').DocumentEventsConfig = {},
): RealtimeFeature {
    return defineFeature({
        manifest: require('../typed-documents/manifest').TypedDocumentsManifest,
        create: ({ router, logger }) => {
            const { DocumentEventsService } = require('../typed-documents/DocumentEventsService') as typeof import('../typed-documents/DocumentEventsService');
            return new DocumentEventsService({ messageRouter: router as any, logger: logger as any, config: opts });
        },
    });
}

export function rooms(opts: {
    stateStore?: import('../room/RoomStateStore').RoomStateStore;
    config?: import('../room/types').RoomConfig;
    metrics?: import('../room/types').RoomMetricsHooks;
} = {}): RealtimeFeature {
    return defineFeature({
        manifest: require('../room/manifest').RoomManifest,
        create: ({ router, logger }) => {
            const { RoomService } = require('../room/RoomService') as typeof import('../room/RoomService');
            return new RoomService({
                messageRouter: router as any,
                logger: logger as any,
                stateStore: opts.stateStore,
                config: opts.config,
                metrics: opts.metrics,
            });
        },
    });
}

export function notifications(opts: {
    store?: import('../notification/RedisNotificationStore').RedisNotificationStore;
    redisClient?: import('../notification/RedisNotificationStore').NotificationRedisClient | null;
    authorize?: import('../notification/NotificationService').NotificationServiceOpts['authorize'];
} = {}): RealtimeFeature {
    return defineFeature({
        manifest: require('../notification/manifest').NotificationManifest,
        create: ({ router, logger }) => {
            const { NotificationService } = require('../notification/NotificationService') as typeof import('../notification/NotificationService');
            return new NotificationService({
                messageRouter: router as any,
                logger: logger as any,
                store: opts.store,
                redisClient: opts.redisClient ?? null,
                authorize: opts.authorize,
            });
        },
    });
}

export function fileUploads(opts: {
    blobStore?: import('../fileupload/FileBlobStore').FileBlobStore;
    metadataStore?: import('../fileupload/FileUploadService').FileUploadMetadataStore;
    publicBaseUrl?: string;
    maxBytes?: number;
    authz?: import('../fileupload/FileUploadService').FileUploadServiceOptions['authz'];
} = {}): RealtimeFeature {
    return defineFeature({
        manifest: require('../fileupload/manifest').FileUploadManifest,
        create: ({ router, logger }) => {
            const { FileUploadService } = require('../fileupload/FileUploadService') as typeof import('../fileupload/FileUploadService');
            return new FileUploadService({
                messageRouter: router as any,
                logger: logger as any,
                blobStore: opts.blobStore,
                metadataRepo: opts.metadataStore,
                publicBaseUrl: opts.publicBaseUrl,
                maxBytes: opts.maxBytes,
                authz: opts.authz,
            });
        },
    });
}

export function collabDocs(opts: {
    snapshotStore?: import('./stores/SnapshotStore').SnapshotStore;
    metadataStore?: import('./stores/MetadataStore').MetadataStore;
    hotCache?: import('./stores/SnapshotStore').HotCache | null;
    authz?: import('./CRDTService').CRDTServiceOpts['authz'];
} = {}): RealtimeFeature {
    return defineFeature({
        manifest: require('./manifest').crdtManifest,
        serviceName: 'crdt', // wire key clients address; manifest identity is 'document-sharing'
        create: ({ router, logger }) => {
            const { CRDTService } = require('./CRDTService') as typeof import('./CRDTService');
            const { MemorySnapshotStore, MemoryHotCache, MemoryMetadataStore } = require('./stores/MemoryStore') as any;
            return new CRDTService({
                messageRouter: router as any,
                logger: logger as any,
                snapshotStore: opts.snapshotStore ?? new MemorySnapshotStore(),
                metadataStore: opts.metadataStore ?? new MemoryMetadataStore(),
                hotCache: opts.hotCache === undefined ? new MemoryHotCache() : opts.hotCache,
                authz: opts.authz,
            });
        },
    });
}

/* eslint-enable @typescript-eslint/no-var-requires */

// ---- attachRealtime -------------------------------------------------------------

export interface AttachRealtimeOptions extends Omit<WsHandlerOptions, 'services' | 'server'> {
    /** The capabilities to attach. Built-ins and defineFeature() results mix freely. */
    features: RealtimeFeature[];
    /** Channel authz for the local router — every feature asks it before a subscribe, a read or a write. See `ChannelAuthorize` for the kinds and the channel names it receives. */
    authorize?: ChannelAuthorize;
    /** Last-mile direct/broadcast/channel delivery filtering for the local router. */
    filterClientMessage?: ClientMessageFilter;
    /** Lifecycle plugins (connect/disconnect/message observers). */
    plugins?: FeaturePlugin[];
    /** Shared logger; defaults to silent. */
    logger?: RouterLogger;
    /**
     * 0.109, opt-in: share one sender-side `publish` decision per (client,
     * channel) per operation scope while younger than this many ms. The host
     * must revoke on observed revocations (`revokePublishProofs`). See the
     * P1-P5 contract in `authorityScope.ts`. Ignored with a custom `router`
     * (pass it to that router).
     */
    publishProofMaxAgeMs?: number;
    /**
     * Swap the transport. When provided, `authorize`/`filterClientMessage`/`plugins` are the
     * custom router's responsibility and are ignored here.
     */
    router?: RealtimeRouter & { _setHandle?: (h: WsHandlerHandle) => void;
        onClientConnect?: (id: string, ctx: import('../server-ws/types').WsAuthContext) => Promise<void> | void;
        shutdown?: () => Promise<void> | void };
}

export interface RealtimeHandle extends WsHandlerHandle {
    router: RealtimeRouter;
    services: Record<string, WsService>;
    manifests: FeatureManifest[];
}

/**
 * Attach realtime features to an EXISTING http(s).Server.
 *
 * Zero-interference by design: the only mutation of your server is the
 * WS upgrade listener `createWsHandler` installs (and removes on dispose).
 * All HTTP routes, middleware and listeners you already have are untouched.
 */
export function attachRealtime(
    server: WsHandlerOptions['server'],
    opts: AttachRealtimeOptions,
): RealtimeHandle {
    const { features, authorize, filterClientMessage, plugins, logger, router: customRouter, publishProofMaxAgeMs, ...wsOpts } = opts;
    const log = logger ?? NOOP_LOGGER;
    const router: NonNullable<AttachRealtimeOptions['router']> = customRouter ?? new LocalRealtimeRouter({ plugins, authorize, filterClientMessage, logger: log, publishProofMaxAgeMs });

    const services: Record<string, WsService> = {};
    const manifests: FeatureManifest[] = [];
    for (const feature of features) {
        const name = feature.serviceName ?? feature.manifest.name;
        if (services[name]) {
            throw new Error(`attachRealtime: duplicate feature '${name}'`);
        }
        services[name] = feature.create({ router, logger: log });
        manifests.push(feature.manifest);
    }

    // Channel membership itself, always present. Not a feature to attach —
    // useWebSocket's subscribe()/unsubscribe(), and the autoResubscribe replay
    // on every reconnect, address `service: 'subscribe'`; with nothing under
    // that name each of those frames came back SERVICE_NOT_AVAILABLE.
    //
    // Registered after the loop and only if free, so a consumer who ships
    // their own 'subscribe' feature keeps it rather than colliding with this.
    if (!services.subscribe) {
        services.subscribe = createSubscribeService(router as RealtimeRouter);
    }

    const consumerOnDisconnect = wsOpts.onDisconnect;
    const consumerBeforeConnect = wsOpts.beforeConnect;
    const handle = createWsHandler({
        ...wsOpts,
        server,
        services,
        beforeConnect: async (clientId, ctx) => {
            await router.onClientConnect?.(clientId, ctx);
            await consumerBeforeConnect?.(clientId, ctx);
        },
        onDisconnect: async (clientId: string) => {
            try { await consumerOnDisconnect?.(clientId); } catch { /* consumer errors stay theirs */ }
            router.removeClient?.(clientId);
        },
    });

    router._setHandle?.(handle);

    // Lifecycle-aware dispose: services with a shutdown()/stop() get it
    // called after socket frames/disconnect hooks drain — CRDT flushes
    // snapshots and sweep/eviction timers clear after their last mutation.
    // Best-effort per service; one feature's
    // teardown failure never blocks the rest.
    const baseDispose = handle.dispose.bind(handle);
    const dispose = async (): Promise<void> => {
        await baseDispose();
        for (const [name, svc] of Object.entries(services)) {
            const s = svc as { shutdown?: () => Promise<void> | void; stop?: () => Promise<void> | void };
            try {
                if (typeof s.shutdown === 'function') await s.shutdown();
                else if (typeof s.stop === 'function') await s.stop();
            } catch (err) {
                log.warn(`[attachRealtime] '${name}' teardown failed`, err);
            }
        }
        await router.shutdown?.();
    };

    return Object.assign(Object.create(null), handle, { router, services, manifests, dispose });
}
