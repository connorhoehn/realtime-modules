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
import { planRealtimeComposition, type CapabilityProvider } from './composition';
import { CompositionLifecycle, RealtimeStartupError, serviceCleanup, type RealtimeCleanup } from './compositionLifecycle';
import type { WsHandlerHandle, WsHandlerOptions, WsHandlerStats, WsService } from '../server-ws/types';
import { createWsHandler } from '../server-ws/createWsHandler';
import {
    LocalRealtimeRouter,
    type ChannelAuthorize,
    type ChannelAuthorizeBatch,
    type ClientMessageFilter,
    type FeaturePlugin,
    type RealtimeRouter,
    type RouterLogger,
} from './router';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { ChatService } from '../chat/ChatService';
import type { NotificationService } from '../notification/NotificationService';
import type { CallService } from '../call/CallService';
import { createSubscribeService } from './subscribeService';
import { normalizeCallPayload } from './authority/engine';
import {
    gateOnPrincipal,
    principalIsCurrent,
    revalidatingAuth,
    withPrincipalRevalidation,
    type FeaturePrincipal,
    type PrincipalRevalidation,
} from './authority/principal';
import {
    withAuthorityCache,
    type AuthorityCacheOptions,
    type AuthorityCacheStats,
    type AuthorityVerdictCache,
} from './authority/verdictCache';

// ---- feature contract ---------------------------------------------------------

/** Everything a feature's factory receives. */
export interface FeatureContext {
    /** The shared router — Local by default, swappable via attach opts. */
    router: RealtimeRouter;
    /** Logger shared by the whole attachment. */
    logger: RouterLogger;
    /**
     * 0.116: the connection's principal, asked fresh — present when
     * `attachRealtime({ principal })` is set. A feature that makes its own
     * admission decision (calls, notifications) gates it on this before and
     * after its own I/O.
     */
    principal?: FeaturePrincipal;
    /** A service by manifest identity or wire alias. Declared dependencies are already constructed. */
    service?: (name: string) => unknown;
    /** Register a partially acquired resource synchronously during create(). Runs after service shutdown. */
    onCleanup?: (cleanup: RealtimeCleanup) => void;
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
        create: ({ router, logger, service }) => {
            const { ChatService } = require('../chat/ChatService') as typeof import('../chat/ChatService');
            const { store, chatStore, identityResolver, unread, ...rest } = opts;
            return new ChatService({
                ...rest,
                // 0.118: `unread.notify` defaults to the attached notifications() service.
                ...(unread ? { unread: { ...unread, notify: unread.notify ?? (() => service?.('notification') as any) } } : {}),
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
    /**
     * 0.116: an `invite` must name the connection's AUTHENTICATED user as
     * `callerId` (the router's `getUserIdForClient`, i.e. the `auth` context's
     * `userId`). Default true: before it, the library trusted `callerId` on
     * invite, so a client could ring as someone else and own the call (its
     * stop rights included). A connection without an authenticated user
     * cannot invite. `false` restores the old trust (anonymous demos only).
     */
    verifyCaller?: boolean;
    /**
     * 0.116: refuse every invite with no targets that would be broadcast —
     * room walk-ins included (see `CallConfig.refuseEmptyTargets`). Default
     * true unless `allowUntargetedInvites` is true. A host whose room
     * walk-ins rely on the untargeted broadcast passes `false`.
     */
    refuseEmptyTargets?: boolean;
} = {}): RealtimeFeature {
    return defineFeature({
        manifest: require('../call/manifest').CallManifest,
        create: ({ router, logger, principal }) => {
            const { CallService } = require('../call/CallService') as typeof import('../call/CallService');
            const { lobbyGuard } = opts;
            const allowUntargetedInvites = opts.allowUntargetedInvites ?? opts.config?.allowUntargetedInvites ?? false;
            let config: import('../call/types').CallConfig = {
                ...(opts.config ?? {}),
                allowUntargetedInvites,
                refuseEmptyTargets: opts.refuseEmptyTargets ?? opts.config?.refuseEmptyTargets ?? !allowUntargetedInvites,
            };
            const verifyCaller = opts.verifyCaller !== false;
            if (lobbyGuard || verifyCaller || principal) {
                const inner = config?.authorize;
                const guard = (clientId: string, data: import('../call/types').CallInvite): boolean => {
                    if (!lobbyGuard) return true;
                    // Flat or nested (`{ data: { lobbyName } }`) — the service accepts both.
                    const raw = normalizeCallPayload(data as Record<string, unknown>).lobbyName;
                    const lobby = typeof raw === 'string' ? raw : '';
                    if (!lobby) return true;
                    const auth = router.getClientData?.(clientId)?.userContext ?? {};
                    try { return lobbyGuard(auth, lobby) !== false; } catch { return false; }
                };
                const callerVerified = (clientId: string, action: string, data: import('../call/types').CallInvite): boolean => {
                    if (!verifyCaller || action !== 'invite') return true;
                    const callerId = normalizeCallPayload(data as Record<string, unknown>).callerId;
                    let userId: string | undefined;
                    try {
                        userId = router.getUserIdForClient?.(clientId);
                        if (userId === undefined) {
                            const fromCtx = router.getClientData?.(clientId)?.userContext?.userId;
                            userId = typeof fromCtx === 'string' && fromCtx ? fromCtx : undefined;
                        }
                    } catch { return false; }
                    return typeof userId === 'string' && userId.length > 0 && callerId === userId;
                };
                const decide = async (clientId: string, action: import('../call/types').CallAction, data: import('../call/types').CallInvite): Promise<boolean> => {
                    if (!callerVerified(clientId, action, data)) return false;
                    if (inner) {
                        let allowed = false;
                        try { allowed = (await inner(clientId, action, data)) === true; } catch { return false; }
                        if (!allowed) return false;
                    }
                    return guard(clientId, data);
                };
                const gated = gateOnPrincipal(principal, decide)!;
                config = { ...config, authorize: (clientId, action, data) => gated(clientId, action, data) };
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
    /** 0.118: fresh per-delivery read admission (see NotificationServiceOpts.admit). */
    admit?: import('../notification/NotificationService').NotificationServiceOpts['admit'];
    /** 0.118: replay the unread inbox to each new connection, once, through `admit`. */
    replayOnConnect?: boolean;
} = {}): RealtimeFeature {
    return defineFeature({
        manifest: require('../notification/manifest').NotificationManifest,
        create: ({ router, logger, principal }) => {
            const { NotificationService } = require('../notification/NotificationService') as typeof import('../notification/NotificationService');
            return new NotificationService({
                messageRouter: router as any,
                logger: logger as any,
                store: opts.store,
                redisClient: opts.redisClient ?? null,
                // 0.116: with `attachRealtime({ principal })`, every notification
                // action first asks the connection's principal (and again after
                // the host's own decision).
                authorize: principal ? gateOnPrincipal(principal, opts.authorize) : opts.authorize,
                admit: opts.admit,
                replayOnConnect: opts.replayOnConnect,
                ...(principal ? { principal } : {}),
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
    /** Explicit adapter guarantees checked before construction; not live availability. */
    capabilityProviders?: readonly CapabilityProvider[];
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
    /**
     * 0.116, opt-in: principal revalidation. `revalidate(ctx)` reads the
     * host's directory (epoch, grants, actor) and refuses (false/throw) a
     * principal that is no longer current. Run at upgrade (after `auth`;
     * refusal = 401), before every `authorize` and recipient filter of the
     * local router (and again after the host's decision with
     * `recheckAfterIo`, the default), and before/after the `calls()` and
     * `notifications()` hooks. With a custom `router`, wrap its hooks with
     * `withPrincipalRevalidation` yourself; upgrade and feature gating still
     * apply.
     */
    principal?: PrincipalRevalidation;
    /**
     * 0.119 (lane R6), opt-in: one host call per channel fan-out for every
     * recipient's subscribe check (see `ChannelAuthorizeBatch`). Without it
     * the local router asks `authorize` per recipient. Composed under the
     * principal revalidation and the verdict cache like `authorize`. Ignored
     * with a custom `router` (pass it to that router).
     */
    authorizeBatch?: ChannelAuthorizeBatch;
    /**
     * 0.119 (lane R6), opt-in: cache POSITIVE `authorize` verdicts per
     * (connection, channel, directory epoch) — contract V1–V7 in
     * `authority/verdictCache.ts`. `epoch(ctx)` must return the principal's
     * CURRENT directory epoch; any change misses and drops that connection's
     * verdicts, and so does a principal revalidation failure. Feed
     * membership events to `handle.authorityCache.invalidateChannel`.
     * Refusals are never cached. Ignored with a custom `router` (wrap its
     * hooks with `withAuthorityCache` yourself).
     */
    authorityCache?: AuthorityCacheOptions;
}

/**
 * 0.119: the services the built-in features register, typed by name. Present
 * only when the matching feature is attached (`chat()`, `notifications()`,
 * `calls()`); any other name stays a `WsService`.
 */
export interface KnownRealtimeServices {
    chat?: ChatService;
    notification?: NotificationService;
    call?: CallService;
}
export type RealtimeServices = KnownRealtimeServices & Record<string, WsService>;

/**
 * One reading of the gateway process. 0.119 (lane R4); 0.120 (lane R6) adds
 * the handler's queue depth, inbound budget counters and event-loop
 * percentiles (`WsHandlerStats`), the verdict cache and the router's queues.
 */
export interface RealtimeStats extends WsHandlerStats {
    /** Connected sockets on this process. */
    sockets: number;
    /** Calls this process holds (0 without `calls()`). */
    activeCalls: number;
    /** Event-loop delay p99 / max in ms since the last `onStats` tick (or process start). */
    eventLoopDelayP99Ms: number;
    eventLoopDelayMaxMs: number;
    rssMb: number;
    ts: string;
    /** 0.120 (lane R6): verdict cache counters, when `authorityCache` is on. */
    authorityCache?: AuthorityCacheStats;
    /** 0.120 (lane R6): the router's own queues, when it reports them (`RedisRealtimeRouter.stats()`). */
    router?: Record<string, number>;
}

export interface RealtimeHandle extends WsHandlerHandle {
    router: RealtimeRouter;
    services: RealtimeServices;
    manifests: FeatureManifest[];
    /**
     * A snapshot of this process: sockets, calls, event-loop delay, RSS
     * (0.119); queue depth, inbound budget, verdict cache and router queues
     * (0.120, lane R6). `reset` restarts the peak queue depth and the
     * event-loop histograms after reading.
     */
    stats(opts?: { reset?: boolean }): RealtimeStats;
    /**
     * Call `listener` with `stats()` every `intervalMs` (default 60 000) and
     * reset the event-loop histogram each tick. Returns the unsubscribe;
     * `dispose()` stops every subscription. The timer is unref'd.
     */
    onStats(listener: (stats: RealtimeStats) => void, opts?: { intervalMs?: number }): () => void;
    /** 0.120 (lane R6): the verdict cache, when `authorityCache` is set — invalidate on membership events. */
    authorityCache?: AuthorityVerdictCache;
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
    const { features, capabilityProviders, authorize, filterClientMessage, plugins, logger, router: customRouter, publishProofMaxAgeMs, principal,
        authorizeBatch, authorityCache: cacheOpts, ...wsOpts } = opts;
    const plan = planRealtimeComposition(features, capabilityProviders);
    for (const feature of plan.features) {
        if (typeof feature.create !== 'function') throw new Error(`Realtime composition: '${feature.manifest.name}' requires a create factory`);
    }
    const log = logger ?? NOOP_LOGGER;
    // Composition, inside out: host hooks → verdict cache → principal
    // revalidation (verdictCache.ts V4: revalidation runs on every check,
    // cache hits included, and a refusal drops the connection's verdicts).
    const cached = !customRouter && cacheOpts && authorize ? withAuthorityCache(authorize, cacheOpts, authorizeBatch) : null;
    const inner = { authorize: cached?.authorize ?? authorize, filterClientMessage,
        authorizeBatch: cached?.authorizeBatch ?? authorizeBatch };
    const verdictCache = cached?.cache;
    const hooks = principal
        ? withPrincipalRevalidation(inner, principal, verdictCache ? { onStale: (id) => verdictCache.invalidateConnection(id) } : {})
        : inner;
    const router: NonNullable<AttachRealtimeOptions['router']> = customRouter ?? new LocalRealtimeRouter({
        plugins, authorize: hooks.authorize, authorizeBatch: hooks.authorize ? hooks.authorizeBatch : undefined,
        filterClientMessage: hooks.filterClientMessage, logger: log, publishProofMaxAgeMs });
    if (principal) wsOpts.auth = revalidatingAuth(wsOpts.auth, principal);
    const featurePrincipal: FeaturePrincipal | undefined = principal ? {
        recheckAfterIo: principal.recheckAfterIo !== false,
        current: async (clientId: string) => {
            let ctx: import('../server-ws/types').WsAuthContext | null | undefined;
            try { ctx = router.getClientData?.(clientId)?.userContext; } catch { return false; }
            if (!await principalIsCurrent(principal, ctx)) return false;
            // A context replaced while revalidating is not the one we judged.
            try { return router.getClientData?.(clientId)?.userContext === ctx; } catch { return false; }
        },
    } : undefined;

    const lifecycle = new CompositionLifecycle();
    lifecycle.add('router', () => router.shutdown?.());
    const services: Record<string, WsService> = Object.create(null);
    const manifests: FeatureManifest[] = [];
    let handle: WsHandlerHandle;
    try {
        for (const feature of plan.features) {
            const name = plan.serviceName(feature.manifest.name)!;
            let constructing = true;
            let service: WsService;
            try {
                service = feature.create({ router, logger: log,
                    service: (alias: string) => services[plan.serviceName(alias) ?? alias],
                    onCleanup: cleanup => {
                        if (!constructing) throw new Error(`'${name}' must register cleanup during create()`);
                        lifecycle.add(`${name} resource`, cleanup);
                    },
                    ...(featurePrincipal ? { principal: featurePrincipal } : {}) });
            } finally { constructing = false; }
            lifecycle.add(name, serviceCleanup(service));
            if (!service || typeof service.handleAction !== 'function') {
                throw new Error(`'${name}' factory must return a synchronous WS service`);
            }
            services[name] = service;
            manifests.push(feature.manifest);
        }
        // Consumers may still supply their own multiplexer.
        if (!services.subscribe) services.subscribe = createSubscribeService(router);
        const consumerOnDisconnect = wsOpts.onDisconnect;
        const consumerBeforeConnect = wsOpts.beforeConnect;
        handle = createWsHandler({
            ...wsOpts, server, services,
            beforeConnect: async (clientId, ctx) => {
                await router.onClientConnect?.(clientId, ctx);
                await consumerBeforeConnect?.(clientId, ctx);
            },
            onDisconnect: async (clientId: string) => {
                try { await consumerOnDisconnect?.(clientId); } catch { /* consumer errors stay theirs */ }
                router.removeClient?.(clientId);
                verdictCache?.invalidateConnection(clientId);
            },
        });
        lifecycle.add('websocket handler', () => handle.dispose());
        router._setHandle?.(handle);
    } catch (error) {
        throw new RealtimeStartupError(error, lifecycle.close());
    }

    let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
    let disposed = false;
    const loopHistogram = () => {
        if (disposed) throw new Error('Realtime attachment is disposed');
        if (!histogram) { histogram = monitorEventLoopDelay({ resolution: 20 }); histogram.enable(); }
        return histogram;
    };
    const statTimers = new Set<ReturnType<typeof setInterval>>();
    const ms = (ns: number) => Math.round((ns / 1e6) * 100) / 100;
    const stats = (statsOpts?: { reset?: boolean }): RealtimeStats => {
        const h = loopHistogram();
        const call = services['call'] as { activeCallCount?: () => number } | undefined;
        const base: WsHandlerStats = handle.stats?.(statsOpts) ?? {
            connections: handle.listClients().length, queueDepth: 0, maxConnectionQueueDepth: 0, peakQueueDepth: 0,
            inbound: { accepted: 0, dropped: 0, limitNotices: 0, limitedConnections: 0 }, eventLoop: null,
        };
        let routerStats: Record<string, number> | undefined;
        try { routerStats = (router as { stats?: () => Record<string, number> }).stats?.(); } catch { routerStats = undefined; }
        const out: RealtimeStats = {
            ...base,
            sockets: handle.listClients().length,
            activeCalls: call?.activeCallCount?.() ?? 0,
            eventLoopDelayP99Ms: ms(h.percentile(99)),
            eventLoopDelayMaxMs: ms(h.max),
            rssMb: Math.round(process.memoryUsage().rss / 1048576),
            ts: new Date().toISOString(),
            ...(verdictCache ? { authorityCache: verdictCache.stats() } : {}),
            ...(routerStats ? { router: routerStats } : {}),
        };
        if (statsOpts?.reset) histogram?.reset();
        return out;
    };
    const onStats = (listener: (s: RealtimeStats) => void, o: { intervalMs?: number } = {}): (() => void) => {
        if (disposed) throw new Error('Realtime attachment is disposed');
        const interval = o.intervalMs && o.intervalMs > 0 ? o.intervalMs : 60_000;
        const timer = setInterval(() => {
            let reading: RealtimeStats | null = null;
            try { reading = stats({ reset: true }); } catch (err) { log.warn('[attachRealtime] stats failed', err); }
            if (reading) { try { listener(reading); } catch (err) { log.warn('[attachRealtime] onStats listener failed', err); } }
        }, interval);
        timer.unref?.();
        statTimers.add(timer);
        return () => { clearInterval(timer); statTimers.delete(timer); };
    };
    lifecycle.add('stats', () => {
        for (const t of statTimers) clearInterval(t);
        statTimers.clear();
        histogram?.disable();
        histogram = null;
    });
    const dispose = lifecycle.disposer();
    const disposeAll = (): Promise<void> => { disposed = true; return dispose(); };
    return Object.assign(Object.create(null), handle, { router, services, manifests, dispose: disposeAll, stats, onStats,
        ...(verdictCache ? { authorityCache: verdictCache } : {}) });
}
