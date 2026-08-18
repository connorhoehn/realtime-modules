import type { FeatureManifest } from '../feature-manifest/types';
import type { WsHandlerHandle, WsHandlerOptions, WsService } from '../server-ws/types';
import { type ChannelAuthorize, type FeaturePlugin, type RealtimeRouter, type RouterLogger } from './router';
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
export declare function defineFeature(feature: RealtimeFeature): RealtimeFeature;
export declare function chat(opts?: {
    store?: import('../chat/ChatStore').ChatStore;
}): RealtimeFeature;
export declare function presence(opts?: {
    heartbeatIntervalMs?: number;
    cleanupIntervalMs?: number;
    disconnectDelayMs?: number;
}): RealtimeFeature;
export declare function cursor(): RealtimeFeature;
export declare function reactions(): RealtimeFeature;
export declare function activity(opts?: {
    historyStore?: import('../activity/ActivityHistoryStore').ActivityHistoryStore;
}): RealtimeFeature;
export declare function social(): RealtimeFeature;
export declare function calls(opts?: {
    stateStore?: import('../call/CallStateStore').CallStateStore;
    config?: import('../call/types').CallConfig;
}): RealtimeFeature;
export declare function ingest(): RealtimeFeature;
export declare function pipeline(): RealtimeFeature;
export declare function typedDocuments(): RealtimeFeature;
export declare function rooms(opts?: {
    stateStore?: import('../room/RoomStateStore').RoomStateStore;
    config?: import('../room/types').RoomConfig;
    metrics?: import('../room/types').RoomMetricsHooks;
}): RealtimeFeature;
export declare function notifications(opts?: {
    store?: import('../notification/RedisNotificationStore').RedisNotificationStore;
    redisClient?: import('../notification/RedisNotificationStore').NotificationRedisClient | null;
}): RealtimeFeature;
export declare function fileUploads(opts?: {
    blobStore?: import('../fileupload/FileBlobStore').FileBlobStore;
    metadataStore?: import('../fileupload/FileUploadService').FileUploadMetadataStore;
    publicBaseUrl?: string;
    maxBytes?: number;
    authz?: import('../fileupload/FileUploadService').FileUploadServiceOptions['authz'];
}): RealtimeFeature;
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
    router?: RealtimeRouter & {
        _setHandle?: (h: WsHandlerHandle) => void;
        removeClient?: (id: string) => void;
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