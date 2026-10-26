// realtime-modules/src/server/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/server`.
//
// Backend CRDT toolkit lifted from gateway's src/realtime-fanout/ in
// CRDT Cut 1. Consumers wire a `SnapshotStore`, `MetadataStore`,
// `HotCache`, and `MessageRouterContract` (all defined in
// `./stores`) and get a ready-to-go CRDTService orchestrator.

import CRDTService from './CRDTService';
import SnapshotManager from './SnapshotManager';
import DocumentMetadataService from './DocumentMetadataService';
import DocumentPresenceService from './DocumentPresenceService';
import AwarenessCoalescer from './AwarenessCoalescer';
import IdleEvictionManager from './IdleEvictionManager';

export {
    CRDTService,
    SnapshotManager,
    DocumentMetadataService,
    DocumentPresenceService,
    AwarenessCoalescer,
    IdleEvictionManager,
};

export type { CRDTServiceOpts, CRDTDocumentAction, OrchestratorMessageRouter } from './CRDTService';
// CRDTServiceOpts.awarenessLedger is an AwarenessLedger — named in an
// exported signature while being importable from no published entry point.
//
// PresenceMode has the same problem and is NOT fixed here:
// DocumentPresenceService uses `export =`, which forbids any other export
// from that module, so exposing it needs a module-shape change rather than
// an export line.
export { AwarenessLedger } from './AwarenessLedger';
// The generic multiplexer attachRealtime registers itself. Exported so a
// consumer wiring createWsHandler by hand gets the same channel membership
// service, rather than rediscovering that useWebSocket's subscribe() has
// nothing to talk to.
export { SubscribeService, createSubscribeService } from './subscribeService';
export type { SubscribeRouter } from './subscribeService';

// Re-export store contracts + memory implementations so consumers only
// need to import from `'@connorhoehn/realtime-modules/server'`.
export type { HotCache, SnapshotStore, VersionMeta } from './stores/SnapshotStore';
export type { DocumentMeta, MetadataStore } from './stores/MetadataStore';
export type { MessageRouterContract } from './stores/MessageRouterContract';
export {
    MemoryHotCache,
    MemoryMetadataStore,
    MemorySnapshotStore,
} from './stores/MemoryStore';

// Configuration constants, exposed so consumers can override windows
// per deployment (e.g. for soak tests).
export * as config from './config';

// FeatureManifest — apps read this to discover env vars + channels.
export { crdtManifest } from './manifest';
export { planRealtimeComposition } from './composition';
export type { CompositionFeature, RealtimeComposition, CapabilityProvider, CapabilityRequirement } from './composition';
export { RealtimeStartupError } from './compositionLifecycle';
export type { RealtimeCleanup, RealtimeCleanupFailure } from './compositionLifecycle';

// Zero-config factory — createRealtimeServer + inMemoryAdapters.
export {
    createRealtimeServer,
    inMemoryAdapters,
    type AdapterMap,
    type AdapterConfig,
    type PerFeatureAdapters,
    type FeaturePlugin,
    type RealtimeServerOptions,
} from './factory';

// ---- pluggable composition layer (v0.19.0) ------------------------------------
// attachRealtime + defineFeature + the thirteen built-in features, plus the
// swappable router contract. See attach.ts for the design principles.
export {
    attachRealtime,
    defineFeature,
    chat,
    presence,
    cursor,
    reactions,
    activity,
    social,
    calls,
    ingest,
    pipeline,
    workGraph,
    typedDocuments,
    rooms,
    notifications,
    fileUploads,
    collabDocs,
} from './attach';
export type {
    AttachRealtimeOptions,
    FeatureContext,
    RealtimeFeature,
    RealtimeHandle,
    RealtimeServices,
    KnownRealtimeServices,
    RealtimeStats,
} from './attach';
export {
    LocalRealtimeRouter,
    PLUGIN_SCOPE_RETAIN_MAX_MS,
    liveUsersOnChannel,
} from './router';
export { RedisRealtimeRouter } from './RedisRealtimeRouter';
export type { RealtimeClusterRedis, RedisRealtimeRouterOptions, RealtimePeerEvents, RealtimeLeaseGroup,
    RealtimeMembershipInvalidation } from './RedisRealtimeRouter';
// 0.117: the fenced-ownership primitives the router is built on, re-exported
// so a host composes LeaseGroup / ReadinessGate / BoundedRedis from the same
// distributed-core copy the router uses.
export { FencedLease, LeaseGroup, ReadinessGate, RedisPeerRegistry, BoundedRedis, createBoundedRedis,
    LeaseHeldError, LeaseFencedError, RedisDeadlineError } from 'distributed-core/cluster/leases';
export type { FencedOwner, FenceEvent, FenceReason, LeaseRedis, LeaseGroupOptions, ReadinessOwner,
    ReadinessSnapshot, ReadinessProbe, PeerSurvey, RedisPeerRegistryOptions, BoundedRedisOptions } from 'distributed-core/cluster/leases';
export type {
    RealtimeRouter,
    RouterLogger,
    ChannelAuthorize,
    ChannelAuthorizeBatch,
    ClientMessageFilter,
    FeaturePlugin as RealtimeFeaturePlugin,
} from './router';
// 0.116.1 — DEPRECATED duplicates. Everything in this block is also exported
// from `./server-ws` (and `WorkGraphStreamService` from `./work-graph/server`),
// which stay the canonical homes; the `./server` copies are kept for one minor
// so existing importers keep compiling, then removed. Aliases (not bare
// re-exports) so the @deprecated tag shows in editors.
import type {
    WsAuthContext as _WsAuthContext,
    WsAuthFn as _WsAuthFn,
} from '../server-ws/types';
import type { AuthSender as _AuthSender, ResolveSender as _ResolveSender } from '../server-ws/senderIdentity';
import type { ServiceChannelPrefix as _ServiceChannelPrefix, ChannelAccessKind as _ChannelAccessKind } from '../server-ws/channelAccess';
import type { AuthorityScope as _AuthorityScope } from '../server-ws/authorityScope';
import { DEFAULT_WS_MAX_PAYLOAD as _DEFAULT_WS_MAX_PAYLOAD, DEFAULT_INDEPENDENT_SERVICES as _DEFAULT_INDEPENDENT_SERVICES } from '../server-ws/types';
import { splitServiceChannel as _splitServiceChannel, baseChannel as _baseChannel, SERVICE_CHANNEL_PREFIXES as _SERVICE_CHANNEL_PREFIXES } from '../server-ws/channelAccess';
import { createAuthorityScope as _createAuthorityScope, publishProofKey as _publishProofKey, revokePublishProofs as _revokePublishProofs, PUBLISH_PROOF_SKEW_MS as _PUBLISH_PROOF_SKEW_MS } from '../server-ws/authorityScope';
import { WorkGraphStreamService as _WorkGraphStreamService } from '../work-graph/streamService';
import type {
    WorkGraphSource as _WorkGraphSource,
    WorkGraphStreamConfig as _WorkGraphStreamConfig,
    WorkGraphStreamScope as _WorkGraphStreamScope,
    WorkGraphStreamSubscription as _WorkGraphStreamSubscription,
    WorkGraphStreamTrigger as _WorkGraphStreamTrigger,
    WorkGraphChannelContext as _WorkGraphChannelContext,
} from '../work-graph/streamService';

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
export const DEFAULT_WS_MAX_PAYLOAD: typeof _DEFAULT_WS_MAX_PAYLOAD = _DEFAULT_WS_MAX_PAYLOAD;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export const DEFAULT_INDEPENDENT_SERVICES: typeof _DEFAULT_INDEPENDENT_SERVICES = _DEFAULT_INDEPENDENT_SERVICES;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export const splitServiceChannel: typeof _splitServiceChannel = _splitServiceChannel;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export const baseChannel: typeof _baseChannel = _baseChannel;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export const SERVICE_CHANNEL_PREFIXES: typeof _SERVICE_CHANNEL_PREFIXES = _SERVICE_CHANNEL_PREFIXES;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export const createAuthorityScope: typeof _createAuthorityScope = _createAuthorityScope;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export const publishProofKey: typeof _publishProofKey = _publishProofKey;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export const revokePublishProofs: typeof _revokePublishProofs = _revokePublishProofs;
/** @deprecated Import from `@connorhoehn/realtime-modules/server-ws`. */
export const PUBLISH_PROOF_SKEW_MS: typeof _PUBLISH_PROOF_SKEW_MS = _PUBLISH_PROOF_SKEW_MS;
/** @deprecated Import from `@connorhoehn/realtime-modules/work-graph/server`. */
export const WorkGraphStreamService: typeof _WorkGraphStreamService = _WorkGraphStreamService;
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

// 0.116 — the authority primitives every multi-tenant host wrote by hand:
// the channel-family mechanism, the partition/DM guard, the fresh-per-request
// authority engine, principal revalidation and the bearer subprotocol parser.
export * from './authority';
export { dmLobbyAdmits } from '../call/lobbyChannel';

export * from "./documentGrant";

export { createCanvasSeed, exportCanvasProjection } from "./canvasSeed";
