// realtime-modules/src/room/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/room`.
//
// v0.18.0 — extracted from websocket-gateway's realtime-fanout/room, where
// it was born gateway-native (live-video-streaming's rooms were the pull
// signal for making it shared). App couplings are injected options: a
// RoomStateStore (Redis-backed impl included, client interface injected),
// cross-node pub/sub, and RoomMetricsHooks. Deployment glue (Redis client
// construction, CRD authz, HTTP mounts) stays with the consumer.

export { RoomService } from './RoomService';
export {
    InMemoryRoomStateStore,
    RedisRoomStateStore,
} from './RoomStateStore';
export type {
    RoomStateStore,
    RoomMemberSnapshot,
    RoomStateRedis,
} from './RoomStateStore';
export {
    ALLOWED_ROOM_ACTIONS,
    CROSS_NODE_ROOM_TOPIC,
} from './types';
export type {
    RoomAction,
    RoomActionPayload,
    RoomConfig,
    RoomCrossNodePubSub,
    RoomErrorFrame,
    RoomLogger,
    RoomMemberLocal,
    RoomMemberRecord,
    RoomMessageRouter,
    RoomMetricsHooks,
    RoomOccupancyDelta,
    RoomServerEvent,
    RoomServiceOptions,
    CrossNodeRoomEvent,
} from './types';
