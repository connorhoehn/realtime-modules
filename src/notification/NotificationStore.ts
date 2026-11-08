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

import type { NotificationRecord } from './types';

export interface NotificationStore {
    /** Persist a record for a user. A record with an id the user already has replaces it (in-memory) or is added again (Redis). */
    append(userId: string, record: NotificationRecord): Promise<void>;
    /** The user's records, oldest first, with `read` reconciled. */
    list(userId: string): Promise<NotificationRecord[]>;
    /** The user's unread records, oldest first (the connect replay). */
    listUnread(userId: string): Promise<NotificationRecord[]>;
    /** Mark one record read. Unknown ids are harmless. */
    markRead(userId: string, id: string): Promise<void>;
    /** Mark every stored record read; returns the ids marked. */
    markAllRead(userId: string): Promise<string[]>;
    /** Delete one record. True when it was stored. Optional: see the header. */
    remove?(userId: string, id: string): Promise<boolean>;
}
