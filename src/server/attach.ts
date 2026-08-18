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
    type FeaturePlugin,
    type RealtimeRouter,
    type RouterLogger,
} from './router';

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

export function chat(opts: { store?: import('../chat/ChatStore').ChatStore } = {}): RealtimeFeature {
    return defineFeature({
        manifest: require('../chat/manifest').ChatManifest,
        create: ({ router, logger }) => {
            const { ChatService } = require('../chat/ChatService') as typeof import('../chat/ChatService');
            return new ChatService({ messageRouter: router as any, logger: logger as any, chatStore: opts.store });
        },
    });
}

export function presence(opts: {
    heartbeatIntervalMs?: number;
    cleanupIntervalMs?: number;
    disconnectDelayMs?: number;
} = {}): RealtimeFeature {
    return defineFeature({
        manifest: require('../presence/manifest').PresenceManifest,
        create: ({ router, logger }) => {
            const PresenceService = require('../presence/PresenceService') as any;
            const Svc = PresenceService.default ?? PresenceService;
            return new Svc(router as any, logger as any, {
                heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 30_000,
                cleanupIntervalMs: opts.cleanupIntervalMs ?? 30_000,
                disconnectDelayMs: opts.disconnectDelayMs ?? 5_000,
            });
        },
    });
}

export function cursor(): RealtimeFeature {
    return defineFeature({
        manifest: require('../cursor/manifest').CursorManifest,
        create: ({ router, logger }) => {
            const { CursorService } = require('../cursor/CursorService') as typeof import('../cursor/CursorService');
            return new CursorService({ messageRouter: router as any, logger: logger as any });
        },
    });
}

export function reactions(): RealtimeFeature {
    return defineFeature({
        manifest: require('../reactions/manifest').ReactionsManifest,
        create: ({ router, logger }) => {
            const { ReactionService } = require('../reactions/ReactionService') as typeof import('../reactions/ReactionService');
            return new ReactionService({ messageRouter: router as any, logger: logger as any });
        },
    });
}

export function activity(opts: {
    historyStore?: import('../activity/ActivityHistoryStore').ActivityHistoryStore;
} = {}): RealtimeFeature {
    return defineFeature({
        manifest: require('../activity/manifest').ActivityManifest,
        create: ({ router, logger }) => {
            const { ActivityService } = require('../activity/ActivityService') as typeof import('../activity/ActivityService');
            return new ActivityService({ messageRouter: router as any, logger: logger as any, historyStore: opts.historyStore });
        },
    });
}

export function social(): RealtimeFeature {
    return defineFeature({
        manifest: require('../social/manifest').SocialManifest,
        create: ({ router, logger }) => {
            const { SocialService } = require('../social/SocialService') as typeof import('../social/SocialService');
            return new SocialService({ messageRouter: router as any, logger: logger as any });
        },
    });
}

export function calls(opts: {
    stateStore?: import('../call/CallStateStore').CallStateStore;
    config?: import('../call/types').CallConfig;
} = {}): RealtimeFeature {
    return defineFeature({
        manifest: require('../call/manifest').CallManifest,
        create: ({ router, logger }) => {
            const { CallService } = require('../call/CallService') as typeof import('../call/CallService');
            return new CallService({
                messageRouter: router as any,
                logger: logger as any,
                stateStore: opts.stateStore,
                config: opts.config,
            });
        },
    });
}

export function ingest(): RealtimeFeature {
    return defineFeature({
        manifest: require('../ingest/manifest').IngestManifest,
        create: ({ router, logger }) => {
            const { IngestService } = require('../ingest/IngestService') as typeof import('../ingest/IngestService');
            return new IngestService({ messageRouter: router as any, logger: logger as any });
        },
    });
}

export function pipeline(): RealtimeFeature {
    return defineFeature({
        manifest: require('../pipeline/manifest').PipelineWsManifest,
        create: ({ router, logger }) => {
            const { PipelineWsRouter } = require('../pipeline/PipelineWsRouter') as typeof import('../pipeline/PipelineWsRouter');
            return new PipelineWsRouter({ messageRouter: router as any, logger: logger as any });
        },
    });
}

export function typedDocuments(): RealtimeFeature {
    return defineFeature({
        manifest: require('../typed-documents/manifest').TypedDocumentsManifest,
        create: ({ router, logger }) => {
            const { DocumentEventsService } = require('../typed-documents/DocumentEventsService') as typeof import('../typed-documents/DocumentEventsService');
            return new DocumentEventsService({ messageRouter: router as any, logger: logger as any });
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

/* eslint-enable @typescript-eslint/no-var-requires */

// ---- attachRealtime -------------------------------------------------------------

export interface AttachRealtimeOptions extends Omit<WsHandlerOptions, 'services' | 'server'> {
    /** The capabilities to attach. Built-ins and defineFeature() results mix freely. */
    features: RealtimeFeature[];
    /** Channel authz for the local router (subscribe + publish). */
    authorize?: ChannelAuthorize;
    /** Lifecycle plugins (connect/disconnect/message observers). */
    plugins?: FeaturePlugin[];
    /** Shared logger; defaults to silent. */
    logger?: RouterLogger;
    /**
     * Swap the transport. When provided, `authorize`/`plugins` are the
     * custom router's responsibility and are ignored here.
     */
    router?: RealtimeRouter & { _setHandle?: (h: WsHandlerHandle) => void; removeClient?: (id: string) => void };
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
    const { features, authorize, plugins, logger, router: customRouter, ...wsOpts } = opts;
    const log = logger ?? NOOP_LOGGER;
    const router = customRouter ?? new LocalRealtimeRouter({ plugins, authorize, logger: log });

    const services: Record<string, WsService> = {};
    const manifests: FeatureManifest[] = [];
    for (const feature of features) {
        const name = feature.manifest.name;
        if (services[name]) {
            throw new Error(`attachRealtime: duplicate feature '${name}'`);
        }
        services[name] = feature.create({ router, logger: log });
        manifests.push(feature.manifest);
    }

    const consumerOnDisconnect = wsOpts.onDisconnect;
    const handle = createWsHandler({
        ...wsOpts,
        server,
        services,
        onDisconnect: (clientId: string) => {
            try { consumerOnDisconnect?.(clientId); } catch { /* consumer errors stay theirs */ }
            router.removeClient?.(clientId);
        },
    });

    router._setHandle?.(handle);

    return Object.assign(Object.create(null), handle, { router, services, manifests });
}
