"use strict";
// realtime-modules/src/notification/NotificationStore.ts
//
// The persistence seam `NotificationService` uses (0.147). Until now the
// service and `notifications({ store })` were typed to the concrete
// `RedisNotificationStore`, so a local app with no Redis had nowhere to keep
// an inbox. `RedisNotificationStore` and `InMemoryNotificationStore` both
// implement this interface.
//
// Contract (both stores honour it; test/notification/NotificationStore.conformance.test.ts):
//   - Writes are best-effort and never throw into the service.
//   - `list` is oldest first with `read` reconciled; `listUnread` is its
//     unread subset.
//   - `markAllRead` returns the ids it marked, so the service can echo one
//     `notification:read` per id.
//   - `remove` (optional) deletes one record by id and returns whether it was
//     there. `NotificationService.resolve` uses it; a store without it gets
//     the record marked read instead, so it is no longer replayed.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=NotificationStore.js.map