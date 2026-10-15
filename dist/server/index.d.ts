import CRDTService from './CRDTService';
import SnapshotManager from './SnapshotManager';
import DocumentMetadataService from './DocumentMetadataService';
import DocumentPresenceService from './DocumentPresenceService';
import AwarenessCoalescer from './AwarenessCoalescer';
import IdleEvictionManager from './IdleEvictionManager';
export { CRDTService, SnapshotManager, DocumentMetadataService, DocumentPresenceService, AwarenessCoalescer, IdleEvictionManager, };
export type { CRDTServiceOpts, CRDTDocumentAction, OrchestratorMessageRouter } from './CRDTService';
export { AwarenessLedger } from './AwarenessLedger';
export { SubscribeService, createSubscribeService } from './subscribeService';
export type { SubscribeRouter } from './subscribeService';
export type { HotCache, SnapshotStore, VersionMeta } from './stores/SnapshotStore';
export type { DocumentMeta, MetadataStore } from './stores/MetadataStore';
export type { MessageRouterContract } from './stores/MessageRouterContract';
export { MemoryHotCache, MemoryMetadataStore, MemorySnapshotStore, } from './stores/MemoryStore';
export * as config from './config';
export { crdtManifest } from './manifest';
export { createRealtimeServer, inMemoryAdapters, type AdapterMap, type AdapterConfig, type PerFeatureAdapters, type FeaturePlugin, type RealtimeServerOptions, } from './factory';
export { attachRealtime, defineFeature, chat, presence, cursor, reactions, activity, social, calls, ingest, pipeline, workGraph, typedDocuments, rooms, notifications, fileUploads, collabDocs, } from './attach';
export type { AttachRealtimeOptions, FeatureContext, RealtimeFeature, RealtimeHandle, } from './attach';
export { LocalRealtimeRouter, PLUGIN_SCOPE_RETAIN_MAX_MS, } from './router';
export { RedisRealtimeRouter } from './RedisRealtimeRouter';
export type { RealtimeClusterRedis, RedisRealtimeRouterOptions, RealtimePeerEvents } from './RedisRealtimeRouter';
export type { RealtimeRouter, RouterLogger, ChannelAuthorize, ClientMessageFilter, FeaturePlugin as RealtimeFeaturePlugin, } from './router';
import type { WsAuthContext as _WsAuthContext, WsAuthFn as _WsAuthFn } from '../server-ws/types';
import type { AuthSender as _AuthSender, ResolveSender as _ResolveSender } from '../server-ws/senderIdentity';
import type { ServiceChannelPrefix as _ServiceChannelPrefix, ChannelAccessKind as _ChannelAccessKind } from '../server-ws/channelAccess';
import type { AuthorityScope as _AuthorityScope } from '../server-ws/authorityScope';
import { DEFAULT_WS_MAX_PAYLOAD as _DEFAULT_WS_MAX_PAYLOAD, DEFAULT_INDEPENDENT_SERVICES as _DEFAULT_INDEPENDENT_SERVICES } from '../server-ws/types';
import { splitServiceChannel as _splitServiceChannel, baseChannel as _baseChannel, SERVICE_CHANNEL_PREFIXES as _SERVICE_CHANNEL_PREFIXES } from '../server-ws/channelAccess';
import { createAuthorityScope as _createAuthorityScope, publishProofKey as _publishProofKey, revokePublishProofs as _revokePublishProofs, PUBLISH_PROOF_SKEW_MS as _PUBLISH_PROOF_SKEW_MS } from '../server-ws/authorityScope';
import { WorkGraphStreamService as _WorkGraphStreamService } from '../work-graph/streamService';
import type { WorkGraphSource as _WorkGraphSource, WorkGraphStreamConfig as _WorkGraphStreamConfig, WorkGraphStreamScope as _WorkGraphStreamScope, WorkGraphStreamSubscription as _WorkGraphStreamSubscription, WorkGraphStreamTrigger as _WorkGraphStreamTrigger, WorkGraphChannelContext as _WorkGraphChannelContext } from '../work-graph/streamService';
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export type WsAuthContext = _WsAuthContext;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export type WsAuthFn = _WsAuthFn;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export type AuthSender = _AuthSender;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export type ResolveSender = _ResolveSender;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export type ServiceChannelPrefix = _ServiceChannelPrefix;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export type ChannelAccessKind = _ChannelAccessKind;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export type AuthorityScope = _AuthorityScope;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export declare const DEFAULT_WS_MAX_PAYLOAD: typeof _DEFAULT_WS_MAX_PAYLOAD;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export declare const DEFAULT_INDEPENDENT_SERVICES: typeof _DEFAULT_INDEPENDENT_SERVICES;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export declare const splitServiceChannel: typeof _splitServiceChannel;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export declare const baseChannel: typeof _baseChannel;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export declare const SERVICE_CHANNEL_PREFIXES: typeof _SERVICE_CHANNEL_PREFIXES;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export declare const createAuthorityScope: typeof _createAuthorityScope;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export declare const publishProofKey: typeof _publishProofKey;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export declare const revokePublishProofs: typeof _revokePublishProofs;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export declare const PUBLISH_PROOF_SKEW_MS: typeof _PUBLISH_PROOF_SKEW_MS;
/** @deprecated Import from `@connorhoehn/realtime-modules/work-graph/server`. */
export declare const WorkGraphStreamService: typeof _WorkGraphStreamService;
/** @deprecated Import from `@connorhoehn/realtime-modules/work-graph/server`. */
export type WorkGraphStreamService = InstanceType<typeof _WorkGraphStreamService>;
/** @deprecated Import from `@connorhoehn/realtime-modules/work-graph/server`. */
export type WorkGraphSource = _WorkGraphSource;
/** @deprecated Import from `@connorhoehn/realtime-modules/work-graph/server`. */
export type WorkGraphStreamConfig = _WorkGraphStreamConfig;
/** @deprecated Import from `@connorhoehn/realtime-modules/work-graph/server`. */
export type WorkGraphStreamScope = _WorkGraphStreamScope;
/** @deprecated Import from `@connorhoehn/realtime-modules/work-graph/server`. */
export type WorkGraphStreamSubscription = _WorkGraphStreamSubscription;
/** @deprecated Import from `@connorhoehn/realtime-modules/work-graph/server`. */
export type WorkGraphStreamTrigger = _WorkGraphStreamTrigger;
/** @deprecated Import from `@connorhoehn/realtime-modules/work-graph/server`. */
export type WorkGraphChannelContext = _WorkGraphChannelContext;
export * from './authority';
export { dmLobbyAdmits } from '../call/lobbyChannel';
export * from "./documentGrant";
export { createCanvasSeed, exportCanvasProjection } from "./canvasSeed";
//# sourceMappingURL=index.d.ts.map