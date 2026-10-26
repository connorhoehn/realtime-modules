"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.defineFeature = defineFeature;
exports.chat = chat;
exports.presence = presence;
exports.cursor = cursor;
exports.reactions = reactions;
exports.activity = activity;
exports.social = social;
exports.calls = calls;
exports.ingest = ingest;
exports.pipeline = pipeline;
exports.workGraph = workGraph;
exports.typedDocuments = typedDocuments;
exports.rooms = rooms;
exports.notifications = notifications;
exports.fileUploads = fileUploads;
exports.collabDocs = collabDocs;
exports.attachRealtime = attachRealtime;
const composition_1 = require("./composition");
const compositionLifecycle_1 = require("./compositionLifecycle");
const createWsHandler_1 = require("../server-ws/createWsHandler");
const router_1 = require("./router");
const node_perf_hooks_1 = require("node:perf_hooks");
const subscribeService_1 = require("./subscribeService");
const engine_1 = require("./authority/engine");
const principal_1 = require("./authority/principal");
const verdictCache_1 = require("./authority/verdictCache");
/** Identity helper — exists so feature definitions type-check at the site. */
function defineFeature(feature) {
    return feature;
}
// ---- built-in features ----------------------------------------------------------
const NOOP_LOGGER = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
/* eslint-disable @typescript-eslint/no-var-requires */
function chat(opts = {}) {
    return defineFeature({
        manifest: require('../chat/manifest').ChatManifest,
        create: ({ router, logger, service }) => {
            const { ChatService } = require('../chat/ChatService');
            const { store, chatStore, identityResolver, unread, ...rest } = opts;
            return new ChatService({
                ...rest,
                // 0.118: `unread.notify` defaults to the attached notifications() service.
                ...(unread ? { unread: { ...unread, notify: unread.notify ?? (() => service?.('notification')) } } : {}),
                messageRouter: router,
                logger: logger,
                chatStore: chatStore ?? store,
                // Default to the router's own identity accessor so chat
                // messages carry userId (enabling edit/delete/addMembers/
                // read receipts/DM enforcement) without every consumer
                // having to rewire it by hand.
                identityResolver: identityResolver ?? ((clientId) => {
                    const userId = router.getUserIdForClient?.(clientId);
                    return userId ? { userId } : null;
                }),
            });
        },
    });
}
function presence(opts = {}) {
    return defineFeature({
        manifest: require('../presence/manifest').PresenceManifest,
        create: ({ router, logger }) => {
            const PresenceService = require('../presence/PresenceService');
            const Svc = PresenceService.default ?? PresenceService;
            // Forward the full config — including `authorizeChannel`, which
            // used to be unreachable through attachRealtime entirely — and
            // let PresenceService own its own field-by-field defaulting
            // (config value → env var → hard default). Previously this
            // factory hardcoded 30_000/30_000/5_000 for the three fields it
            // did pass, which shadowed the env-var fallback for anyone not
            // explicitly setting them.
            return new Svc(router, logger, opts);
        },
    });
}
function cursor(opts = {}) {
    return defineFeature({
        manifest: require('../cursor/manifest').CursorManifest,
        create: ({ router, logger }) => {
            const { CursorService } = require('../cursor/CursorService');
            return new CursorService({ messageRouter: router, logger: logger, config: opts });
        },
    });
}
function reactions(opts = {}) {
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
            const { ReactionService } = require('../reactions/ReactionService');
            const { identityResolver, ...rest } = opts;
            return new ReactionService({
                messageRouter: router,
                logger: logger,
                config: {
                    ...rest,
                    // Same default as chat(): stamp userId from the
                    // router's own identity accessor so reaction events
                    // carry a userId without every consumer rewiring it.
                    identityResolver: identityResolver ?? ((clientId) => {
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
function activity(opts = {}) {
    return defineFeature({
        manifest: require('../activity/manifest').ActivityManifest,
        create: ({ router, logger }) => {
            const { ActivityService } = require('../activity/ActivityService');
            return new ActivityService({
                messageRouter: router,
                logger: logger,
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
function social(opts = {}) {
    return defineFeature({
        manifest: require('../social/manifest').SocialManifest,
        create: ({ router, logger }) => {
            const { SocialService } = require('../social/SocialService');
            return new SocialService({ messageRouter: router, logger: logger, config: opts });
        },
    });
}
function calls(opts = {}) {
    return defineFeature({
        manifest: require('../call/manifest').CallManifest,
        create: ({ router, logger, principal }) => {
            const { CallService } = require('../call/CallService');
            const { lobbyGuard } = opts;
            const allowUntargetedInvites = opts.allowUntargetedInvites ?? opts.config?.allowUntargetedInvites ?? false;
            let config = {
                ...(opts.config ?? {}),
                allowUntargetedInvites,
                refuseEmptyTargets: opts.refuseEmptyTargets ?? opts.config?.refuseEmptyTargets ?? !allowUntargetedInvites,
            };
            const verifyCaller = opts.verifyCaller !== false;
            if (lobbyGuard || verifyCaller || principal) {
                const inner = config?.authorize;
                const guard = (clientId, data) => {
                    if (!lobbyGuard)
                        return true;
                    // Flat or nested (`{ data: { lobbyName } }`) — the service accepts both.
                    const raw = (0, engine_1.normalizeCallPayload)(data).lobbyName;
                    const lobby = typeof raw === 'string' ? raw : '';
                    if (!lobby)
                        return true;
                    const auth = router.getClientData?.(clientId)?.userContext ?? {};
                    try {
                        return lobbyGuard(auth, lobby) !== false;
                    }
                    catch {
                        return false;
                    }
                };
                const callerVerified = (clientId, action, data) => {
                    if (!verifyCaller || action !== 'invite')
                        return true;
                    const callerId = (0, engine_1.normalizeCallPayload)(data).callerId;
                    let userId;
                    try {
                        userId = router.getUserIdForClient?.(clientId);
                        if (userId === undefined) {
                            const fromCtx = router.getClientData?.(clientId)?.userContext?.userId;
                            userId = typeof fromCtx === 'string' && fromCtx ? fromCtx : undefined;
                        }
                    }
                    catch {
                        return false;
                    }
                    return typeof userId === 'string' && userId.length > 0 && callerId === userId;
                };
                const decide = async (clientId, action, data) => {
                    if (!callerVerified(clientId, action, data))
                        return false;
                    if (inner) {
                        let allowed = false;
                        try {
                            allowed = (await inner(clientId, action, data)) === true;
                        }
                        catch {
                            return false;
                        }
                        if (!allowed)
                            return false;
                    }
                    return guard(clientId, data);
                };
                const gated = (0, principal_1.gateOnPrincipal)(principal, decide);
                config = { ...config, authorize: (clientId, action, data) => gated(clientId, action, data) };
            }
            return new CallService({
                messageRouter: router,
                logger: logger,
                stateStore: opts.stateStore,
                config,
                ...(typeof opts.rejoinGraceMs === 'number' ? { rejoinGraceMs: opts.rejoinGraceMs } : {}),
                ...(opts.crossNodePubSub ? { crossNodePubSub: opts.crossNodePubSub } : {}),
                ...(router.isClientAlive ? { isClientAlive: router.isClientAlive.bind(router) } : {}),
            });
        },
    });
}
function ingest(opts = {}) {
    return defineFeature({
        manifest: require('../ingest/manifest').IngestManifest,
        create: ({ router, logger }) => {
            const { IngestService } = require('../ingest/IngestService');
            return new IngestService({ messageRouter: router, logger: logger, config: opts });
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
function pipeline(opts = {}) {
    return defineFeature({
        manifest: require('../pipeline/manifest').PipelineWsManifest,
        // Wire key 'pipeline', manifest identity 'pipeline-ws' — same split as
        // reactions and crdt. usePipelineRunStatus sends `service: 'pipeline'`.
        serviceName: 'pipeline',
        create: ({ router, logger }) => {
            const { PipelineWsRouter } = require('../pipeline/PipelineWsRouter');
            return new PipelineWsRouter({ messageRouter: router, logger: logger, config: opts });
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
function workGraph(opts = {}) {
    return defineFeature({
        manifest: require('../work-graph/manifest').WorkGraphStreamManifest,
        create: ({ router, logger }) => {
            const { WorkGraphStreamService } = require('../work-graph/streamService');
            return new WorkGraphStreamService({ messageRouter: router, logger, config: opts });
        },
    });
}
function typedDocuments(opts = {}) {
    return defineFeature({
        manifest: require('../typed-documents/manifest').TypedDocumentsManifest,
        create: ({ router, logger }) => {
            const { DocumentEventsService } = require('../typed-documents/DocumentEventsService');
            return new DocumentEventsService({ messageRouter: router, logger: logger, config: opts });
        },
    });
}
function rooms(opts = {}) {
    return defineFeature({
        manifest: require('../room/manifest').RoomManifest,
        create: ({ router, logger }) => {
            const { RoomService } = require('../room/RoomService');
            return new RoomService({
                messageRouter: router,
                logger: logger,
                stateStore: opts.stateStore,
                config: opts.config,
                metrics: opts.metrics,
            });
        },
    });
}
function notifications(opts = {}) {
    return defineFeature({
        manifest: require('../notification/manifest').NotificationManifest,
        create: ({ router, logger, principal }) => {
            const { NotificationService } = require('../notification/NotificationService');
            return new NotificationService({
                messageRouter: router,
                logger: logger,
                store: opts.store,
                redisClient: opts.redisClient ?? null,
                // 0.116: with `attachRealtime({ principal })`, every notification
                // action first asks the connection's principal (and again after
                // the host's own decision).
                authorize: principal ? (0, principal_1.gateOnPrincipal)(principal, opts.authorize) : opts.authorize,
                admit: opts.admit,
                replayOnConnect: opts.replayOnConnect,
                ...(principal ? { principal } : {}),
            });
        },
    });
}
function fileUploads(opts = {}) {
    return defineFeature({
        manifest: require('../fileupload/manifest').FileUploadManifest,
        create: ({ router, logger }) => {
            const { FileUploadService } = require('../fileupload/FileUploadService');
            return new FileUploadService({
                messageRouter: router,
                logger: logger,
                blobStore: opts.blobStore,
                metadataRepo: opts.metadataStore,
                publicBaseUrl: opts.publicBaseUrl,
                maxBytes: opts.maxBytes,
                authz: opts.authz,
            });
        },
    });
}
function collabDocs(opts = {}) {
    return defineFeature({
        manifest: require('./manifest').crdtManifest,
        serviceName: 'crdt', // wire key clients address; manifest identity is 'document-sharing'
        create: ({ router, logger }) => {
            const { CRDTService } = require('./CRDTService');
            const { MemorySnapshotStore, MemoryHotCache, MemoryMetadataStore } = require('./stores/MemoryStore');
            return new CRDTService({
                messageRouter: router,
                logger: logger,
                snapshotStore: opts.snapshotStore ?? new MemorySnapshotStore(),
                metadataStore: opts.metadataStore ?? new MemoryMetadataStore(),
                hotCache: opts.hotCache === undefined ? new MemoryHotCache() : opts.hotCache,
                authz: opts.authz,
            });
        },
    });
}
/**
 * Attach realtime features to an EXISTING http(s).Server.
 *
 * Zero-interference by design: the only mutation of your server is the
 * WS upgrade listener `createWsHandler` installs (and removes on dispose).
 * All HTTP routes, middleware and listeners you already have are untouched.
 */
function attachRealtime(server, opts) {
    const { features, capabilityProviders, authorize, filterClientMessage, plugins, logger, router: customRouter, publishProofMaxAgeMs, principal, authorizeBatch, authorityCache: cacheOpts, ...wsOpts } = opts;
    const plan = (0, composition_1.planRealtimeComposition)(features, capabilityProviders);
    for (const feature of plan.features) {
        if (typeof feature.create !== 'function')
            throw new Error(`Realtime composition: '${feature.manifest.name}' requires a create factory`);
    }
    const log = logger ?? NOOP_LOGGER;
    // Composition, inside out: host hooks → verdict cache → principal
    // revalidation (verdictCache.ts V4: revalidation runs on every check,
    // cache hits included, and a refusal drops the connection's verdicts).
    const cached = !customRouter && cacheOpts && authorize ? (0, verdictCache_1.withAuthorityCache)(authorize, cacheOpts, authorizeBatch) : null;
    const inner = { authorize: cached?.authorize ?? authorize, filterClientMessage,
        authorizeBatch: cached?.authorizeBatch ?? authorizeBatch };
    const verdictCache = cached?.cache;
    const hooks = principal
        ? (0, principal_1.withPrincipalRevalidation)(inner, principal, verdictCache ? { onStale: (id) => verdictCache.invalidateConnection(id) } : {})
        : inner;
    const router = customRouter ?? new router_1.LocalRealtimeRouter({
        plugins, authorize: hooks.authorize, authorizeBatch: hooks.authorize ? hooks.authorizeBatch : undefined,
        filterClientMessage: hooks.filterClientMessage, logger: log, publishProofMaxAgeMs
    });
    if (principal)
        wsOpts.auth = (0, principal_1.revalidatingAuth)(wsOpts.auth, principal);
    const featurePrincipal = principal ? {
        recheckAfterIo: principal.recheckAfterIo !== false,
        current: async (clientId) => {
            let ctx;
            try {
                ctx = router.getClientData?.(clientId)?.userContext;
            }
            catch {
                return false;
            }
            if (!await (0, principal_1.principalIsCurrent)(principal, ctx))
                return false;
            // A context replaced while revalidating is not the one we judged.
            try {
                return router.getClientData?.(clientId)?.userContext === ctx;
            }
            catch {
                return false;
            }
        },
    } : undefined;
    const lifecycle = new compositionLifecycle_1.CompositionLifecycle();
    lifecycle.add('router', () => router.shutdown?.());
    const services = Object.create(null);
    const manifests = [];
    let handle;
    try {
        for (const feature of plan.features) {
            const name = plan.serviceName(feature.manifest.name);
            let constructing = true;
            let service;
            try {
                service = feature.create({ router, logger: log,
                    service: (alias) => services[plan.serviceName(alias) ?? alias],
                    onCleanup: cleanup => {
                        if (!constructing)
                            throw new Error(`'${name}' must register cleanup during create()`);
                        lifecycle.add(`${name} resource`, cleanup);
                    },
                    ...(featurePrincipal ? { principal: featurePrincipal } : {}) });
            }
            finally {
                constructing = false;
            }
            lifecycle.add(name, (0, compositionLifecycle_1.serviceCleanup)(service));
            if (!service || typeof service.handleAction !== 'function') {
                throw new Error(`'${name}' factory must return a synchronous WS service`);
            }
            services[name] = service;
            manifests.push(feature.manifest);
        }
        // Consumers may still supply their own multiplexer.
        if (!services.subscribe)
            services.subscribe = (0, subscribeService_1.createSubscribeService)(router);
        const consumerOnDisconnect = wsOpts.onDisconnect;
        const consumerBeforeConnect = wsOpts.beforeConnect;
        handle = (0, createWsHandler_1.createWsHandler)({
            ...wsOpts, server, services,
            beforeConnect: async (clientId, ctx) => {
                await router.onClientConnect?.(clientId, ctx);
                await consumerBeforeConnect?.(clientId, ctx);
            },
            onDisconnect: async (clientId) => {
                try {
                    await consumerOnDisconnect?.(clientId);
                }
                catch { /* consumer errors stay theirs */ }
                router.removeClient?.(clientId);
                verdictCache?.invalidateConnection(clientId);
            },
        });
        lifecycle.add('websocket handler', () => handle.dispose());
        router._setHandle?.(handle);
    }
    catch (error) {
        throw new compositionLifecycle_1.RealtimeStartupError(error, lifecycle.close());
    }
    let histogram = null;
    let disposed = false;
    const loopHistogram = () => {
        if (disposed)
            throw new Error('Realtime attachment is disposed');
        if (!histogram) {
            histogram = (0, node_perf_hooks_1.monitorEventLoopDelay)({ resolution: 20 });
            histogram.enable();
        }
        return histogram;
    };
    const statTimers = new Set();
    const ms = (ns) => Math.round((ns / 1e6) * 100) / 100;
    const stats = (statsOpts) => {
        const h = loopHistogram();
        const call = services['call'];
        const base = handle.stats?.(statsOpts) ?? {
            connections: handle.listClients().length, queueDepth: 0, maxConnectionQueueDepth: 0, peakQueueDepth: 0,
            inbound: { accepted: 0, dropped: 0, limitNotices: 0, limitedConnections: 0 }, eventLoop: null,
        };
        let routerStats;
        try {
            routerStats = router.stats?.();
        }
        catch {
            routerStats = undefined;
        }
        const out = {
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
        if (statsOpts?.reset)
            histogram?.reset();
        return out;
    };
    const onStats = (listener, o = {}) => {
        if (disposed)
            throw new Error('Realtime attachment is disposed');
        const interval = o.intervalMs && o.intervalMs > 0 ? o.intervalMs : 60_000;
        const timer = setInterval(() => {
            let reading = null;
            try {
                reading = stats({ reset: true });
            }
            catch (err) {
                log.warn('[attachRealtime] stats failed', err);
            }
            if (reading) {
                try {
                    listener(reading);
                }
                catch (err) {
                    log.warn('[attachRealtime] onStats listener failed', err);
                }
            }
        }, interval);
        timer.unref?.();
        statTimers.add(timer);
        return () => { clearInterval(timer); statTimers.delete(timer); };
    };
    lifecycle.add('stats', () => {
        for (const t of statTimers)
            clearInterval(t);
        statTimers.clear();
        histogram?.disable();
        histogram = null;
    });
    const dispose = lifecycle.disposer();
    const disposeAll = () => { disposed = true; return dispose(); };
    return Object.assign(Object.create(null), handle, { router, services, manifests, dispose: disposeAll, stats, onStats,
        ...(verdictCache ? { authorityCache: verdictCache } : {}) });
}
//# sourceMappingURL=attach.js.map