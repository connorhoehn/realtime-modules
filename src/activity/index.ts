// realtime-modules/src/activity/index.ts
//
// Subpath entry — `@connorhoehn/realtime-modules/activity`.
//
// Lifted from gateway/src/realtime-fanout/activity-service.ts in Wave 2.
// Consumers wire an `ActivityHistoryStore` (defaults to
// InMemoryActivityHistoryStore) and an `ActivityMessageRouter` and get a
// ready-to-go ActivityService.
//
// What's left in gateway (not part of the lifted surface):
//   - EventCatalog `setEventCatalog` setter + durable `activity.recorded`
//     publish-with-retry path (depends on EC client which is gateway-
//     owned),
//   - Concrete Redis-backed ActivityHistoryStore adapter (stays in
//     gateway, satisfies the interface exported here).

export { ActivityService } from './ActivityService';
export type {
    ActivityServiceOpts,
    ActivityMessageRouter,
    ActivityLogger,
} from './ActivityService';

export {
    InMemoryActivityHistoryStore,
} from './ActivityHistoryStore';
export type { ActivityHistoryStore } from './ActivityHistoryStore';

export type { ActivityEvent, ActivityEventConfig } from './types';

export { ActivityManifest } from './manifest';

export { default } from './ActivityService';
