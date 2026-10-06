import type { FeatureManifest } from '../feature-manifest/types';
import type { WsHandlerHandle, WsHandlerOptions, WsService } from '../server-ws/types';
import { type ChannelAuthorize, type ClientMessageFilter, type FeaturePlugin, type RealtimeRouter, type RouterLogger } from './router';
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
export declare function defineFeature(feature: RealtimeFeature): RealtimeFeature;
export declare function chat(opts?: Omit<import('../chat/ChatService').ChatServiceOpts, 'messageRouter' | 'logger' | 'chatStore'> & {
    /** @deprecated use `chatStore` — kept for backwards compatibility. */
    store?: import('../chat/ChatStore').ChatStore;
    chatStore?: import('../chat/ChatStore').ChatStore;
}): RealtimeFeature;
export declare function presence(opts?: import('../presence/types').PresenceConfig): RealtimeFeature;
export declare function cursor(opts?: import('../cursor/types').CursorConfig): RealtimeFeature;
export declare function reactions(opts?: import('../reactions/types').ReactionConfig): RealtimeFeature;
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
export declare function activity(opts?: {
    historyStore?: import('../activity/ActivityHistoryStore').ActivityHistoryStore;
    config?: import('../activity/types').ActivityEventConfig;
    /** Shorthand for `config.allowClientPublish`. Default false. */
    allowClientPublish?: boolean;
    /** Shorthand for `config.autoSubscribeBroadcast`. Default false. */
    autoSubscribeBroadcast?: boolean;
}): RealtimeFeature;
export declare function social(opts?: import('../social/types').SocialConfig): RealtimeFeature;
export declare function calls(opts?: {
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
}): RealtimeFeature;
export declare function ingest(opts?: import('../ingest/types').IngestConfig): RealtimeFeature;
/**
 * Pipeline run events. Clients subscribe `pipeline:run:<id>`; the cross-run
 * firehoses (`pipeline:all`, `pipeline:approvals`) are refused unless enabled
 * with `firehoses` (0.107). `channelFor(wire, { clientId, runId, userContext })`
 * maps a wire channel to the router channel actually subscribed (a tenant
 * partition), which the router's `authorize` then judges; producers emit to
 * that router channel through `handle.services.pipeline.emitEvent`.
 */
export declare function pipeline(opts?: import('../pipeline/types').PipelineConfig): RealtimeFeature;
/**
 * The work-graph stream behind `useWorkGraph` (0.108). Clients subscribe a
 * person-day from a snapshot cursor; `channelFor(scope, ctx)` maps it to a
 * router channel (absent or null refuses — default deny, no firehose) which
 * the router's `authorize` judges. Server-publish only: the host calls
 * `handle.services['work-graph'].publish(channel, change)` and its
 * `source.frames(sub, trigger)` computes each subscriber's own deltas from
 * that subscriber's cursor. See `WorkGraphStreamService`.
 */
export declare function workGraph(opts?: import('../work-graph/streamService').WorkGraphStreamConfig): RealtimeFeature;
export declare function typedDocuments(opts?: import('../typed-documents/types').DocumentEventsConfig): RealtimeFeature;
export declare function rooms(opts?: {
    stateStore?: import('../room/RoomStateStore').RoomStateStore;
    config?: import('../room/types').RoomConfig;
    metrics?: import('../room/types').RoomMetricsHooks;
}): RealtimeFeature;
export declare function notifications(opts?: {
    store?: import('../notification/RedisNotificationStore').RedisNotificationStore;
    redisClient?: import('../notification/RedisNotificationStore').NotificationRedisClient | null;
    authorize?: import('../notification/NotificationService').NotificationServiceOpts['authorize'];
}): RealtimeFeature;
export declare function fileUploads(opts?: {
    blobStore?: import('../fileupload/FileBlobStore').FileBlobStore;
    metadataStore?: import('../fileupload/FileUploadService').FileUploadMetadataStore;
    publicBaseUrl?: string;
    maxBytes?: number;
    authz?: import('../fileupload/FileUploadService').FileUploadServiceOptions['authz'];
}): RealtimeFeature;
export declare function collabDocs(opts?: {
    snapshotStore?: import('./stores/SnapshotStore').SnapshotStore;
    metadataStore?: import('./stores/MetadataStore').MetadataStore;
    hotCache?: import('./stores/SnapshotStore').HotCache | null;
    authz?: import('./CRDTService').CRDTServiceOpts['authz'];
}): RealtimeFeature;
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
     * Swap the transport. When provided, `authorize`/`filterClientMessage`/`plugins` are the
     * custom router's responsibility and are ignored here.
     */
    router?: RealtimeRouter & {
        _setHandle?: (h: WsHandlerHandle) => void;
        onClientConnect?: (id: string, ctx: import('../server-ws/types').WsAuthContext) => Promise<void> | void;
        shutdown?: () => Promise<void> | void;
    };
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
export declare function attachRealtime(server: WsHandlerOptions['server'], opts: AttachRealtimeOptions): RealtimeHandle;
//# sourceMappingURL=attach.d.ts.map