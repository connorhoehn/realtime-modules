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
exports.typedDocuments = typedDocuments;
exports.rooms = rooms;
exports.notifications = notifications;
exports.fileUploads = fileUploads;
exports.collabDocs = collabDocs;
exports.attachRealtime = attachRealtime;
const createWsHandler_1 = require("../server-ws/createWsHandler");
const router_1 = require("./router");
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
        create: ({ router, logger }) => {
            const { ChatService } = require('../chat/ChatService');
            return new ChatService({ messageRouter: router, logger: logger, chatStore: opts.store });
        },
    });
}
function presence(opts = {}) {
    return defineFeature({
        manifest: require('../presence/manifest').PresenceManifest,
        create: ({ router, logger }) => {
            const PresenceService = require('../presence/PresenceService');
            const Svc = PresenceService.default ?? PresenceService;
            return new Svc(router, logger, {
                heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 30_000,
                cleanupIntervalMs: opts.cleanupIntervalMs ?? 30_000,
                disconnectDelayMs: opts.disconnectDelayMs ?? 5_000,
            });
        },
    });
}
function cursor() {
    return defineFeature({
        manifest: require('../cursor/manifest').CursorManifest,
        create: ({ router, logger }) => {
            const { CursorService } = require('../cursor/CursorService');
            return new CursorService({ messageRouter: router, logger: logger });
        },
    });
}
function reactions() {
    return defineFeature({
        manifest: require('../reactions/manifest').ReactionsManifest,
        create: ({ router, logger }) => {
            const { ReactionService } = require('../reactions/ReactionService');
            return new ReactionService({ messageRouter: router, logger: logger });
        },
    });
}
function activity(opts = {}) {
    return defineFeature({
        manifest: require('../activity/manifest').ActivityManifest,
        create: ({ router, logger }) => {
            const { ActivityService } = require('../activity/ActivityService');
            return new ActivityService({ messageRouter: router, logger: logger, historyStore: opts.historyStore });
        },
    });
}
function social() {
    return defineFeature({
        manifest: require('../social/manifest').SocialManifest,
        create: ({ router, logger }) => {
            const { SocialService } = require('../social/SocialService');
            return new SocialService({ messageRouter: router, logger: logger });
        },
    });
}
function calls(opts = {}) {
    return defineFeature({
        manifest: require('../call/manifest').CallManifest,
        create: ({ router, logger }) => {
            const { CallService } = require('../call/CallService');
            return new CallService({
                messageRouter: router,
                logger: logger,
                stateStore: opts.stateStore,
                config: opts.config,
            });
        },
    });
}
function ingest() {
    return defineFeature({
        manifest: require('../ingest/manifest').IngestManifest,
        create: ({ router, logger }) => {
            const { IngestService } = require('../ingest/IngestService');
            return new IngestService({ messageRouter: router, logger: logger });
        },
    });
}
function pipeline() {
    return defineFeature({
        manifest: require('../pipeline/manifest').PipelineWsManifest,
        create: ({ router, logger }) => {
            const { PipelineWsRouter } = require('../pipeline/PipelineWsRouter');
            return new PipelineWsRouter({ messageRouter: router, logger: logger });
        },
    });
}
function typedDocuments() {
    return defineFeature({
        manifest: require('../typed-documents/manifest').TypedDocumentsManifest,
        create: ({ router, logger }) => {
            const { DocumentEventsService } = require('../typed-documents/DocumentEventsService');
            return new DocumentEventsService({ messageRouter: router, logger: logger });
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
        create: ({ router, logger }) => {
            const { NotificationService } = require('../notification/NotificationService');
            return new NotificationService({
                messageRouter: router,
                logger: logger,
                store: opts.store,
                redisClient: opts.redisClient ?? null,
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
    const { features, authorize, plugins, logger, router: customRouter, ...wsOpts } = opts;
    const log = logger ?? NOOP_LOGGER;
    const router = customRouter ?? new router_1.LocalRealtimeRouter({ plugins, authorize, logger: log });
    const services = {};
    const manifests = [];
    for (const feature of features) {
        const name = feature.serviceName ?? feature.manifest.name;
        if (services[name]) {
            throw new Error(`attachRealtime: duplicate feature '${name}'`);
        }
        services[name] = feature.create({ router, logger: log });
        manifests.push(feature.manifest);
    }
    const consumerOnDisconnect = wsOpts.onDisconnect;
    const handle = (0, createWsHandler_1.createWsHandler)({
        ...wsOpts,
        server,
        services,
        onDisconnect: (clientId) => {
            try {
                consumerOnDisconnect?.(clientId);
            }
            catch { /* consumer errors stay theirs */ }
            router.removeClient?.(clientId);
        },
    });
    router._setHandle?.(handle);
    // Lifecycle-aware dispose: services with a shutdown()/stop() get it
    // called before the WS handler tears down — CRDT flushes snapshots,
    // sweep/eviction timers clear. Best-effort per service; one feature's
    // teardown failure never blocks the rest.
    const baseDispose = handle.dispose.bind(handle);
    const dispose = async () => {
        for (const [name, svc] of Object.entries(services)) {
            const s = svc;
            try {
                if (typeof s.shutdown === 'function')
                    await s.shutdown();
                else if (typeof s.stop === 'function')
                    await s.stop();
            }
            catch (err) {
                log.warn(`[attachRealtime] '${name}' teardown failed`, err);
            }
        }
        await baseDispose();
    };
    return Object.assign(Object.create(null), handle, { router, services, manifests, dispose });
}
//# sourceMappingURL=attach.js.map