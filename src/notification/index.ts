// realtime-modules/src/notification/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/notification`.
//
// v0.18.0 — extracted verbatim from websocket-gateway (the module was
// already dependency-pure: the Redis client is an injected interface).
// The gateway keeps its HTTP notify-route and Redis client construction.

export { NotificationService } from './NotificationService';
export { RedisNotificationStore } from './RedisNotificationStore';
export type { NotificationRedisClient } from './RedisNotificationStore';
export * from './types';
export {
    NOTIFICATION_MAX_PER_USER,
    NOTIFICATION_TTL_SEC,
} from './constants';
