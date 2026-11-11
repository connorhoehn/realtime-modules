"use strict";
// realtime-modules/src/notification/InMemoryNotificationStore.ts
//
// A process-local `NotificationStore` (0.147) for a local app with no Redis —
// for example a desktop tool that rebuilds its inbox from its own records at
// start. Same shape as the Redis store: per user, capped at `maxPerUser`
// (oldest dropped first), read state kept with the record. Nothing expires:
// a record leaves when it is removed (`remove`, `NotificationService.resolve`)
// or pushed out by the cap. Appending an id the user already has replaces
// that record in place of a duplicate (its read state is kept unless the new
// record says otherwise), so a producer can re-announce a need idempotently.
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryNotificationStore = void 0;
const constants_1 = require("./constants");
class InMemoryNotificationStore {
    maxPerUser;
    /** userId → id → record (Map keeps insertion order; `list` sorts by timestamp). */
    inboxes = new Map();
    constructor(opts = {}) {
        const max = opts.maxPerUser ?? constants_1.NOTIFICATION_MAX_PER_USER;
        if (!Number.isSafeInteger(max) || max < 1)
            throw new Error('InMemoryNotificationStore: maxPerUser must be a positive integer');
        this.maxPerUser = max;
    }
    async append(userId, record) {
        if (!userId || !record || typeof record.id !== 'string' || !record.id)
            return;
        let inbox = this.inboxes.get(userId);
        if (!inbox) {
            inbox = new Map();
            this.inboxes.set(userId, inbox);
        }
        const previous = inbox.get(record.id);
        const read = record.read ?? previous?.read;
        inbox.set(record.id, { ...copy(record), ...(read !== undefined ? { read } : {}) });
        if (inbox.size > this.maxPerUser) {
            for (const r of this.sorted(inbox).slice(0, inbox.size - this.maxPerUser))
                inbox.delete(r.id);
        }
    }
    async list(userId) {
        const inbox = this.inboxes.get(userId);
        return inbox ? this.sorted(inbox).map(copy) : [];
    }
    async listUnread(userId) {
        return (await this.list(userId)).filter((n) => !n.read);
    }
    async markRead(userId, id) {
        const record = this.inboxes.get(userId)?.get(id);
        if (record)
            record.read = true;
    }
    async markAllRead(userId) {
        const inbox = this.inboxes.get(userId);
        if (!inbox)
            return [];
        const ids = [];
        for (const record of this.sorted(inbox)) {
            record.read = true;
            ids.push(record.id);
        }
        return ids;
    }
    async remove(userId, id) {
        const inbox = this.inboxes.get(userId);
        if (!inbox?.delete(id))
            return false;
        if (inbox.size === 0)
            this.inboxes.delete(userId);
        return true;
    }
    /** Forget every user's inbox (a host rebuilding from its own records). */
    clear() {
        this.inboxes.clear();
    }
    sorted(inbox) {
        // Stable: equal timestamps keep insertion order.
        return [...inbox.values()].sort((a, b) => score(a.timestamp) - score(b.timestamp));
    }
}
exports.InMemoryNotificationStore = InMemoryNotificationStore;
function score(timestamp) {
    const t = Date.parse(timestamp);
    return Number.isNaN(t) ? 0 : t;
}
function copy(record) {
    return {
        ...record,
        ...(record.payload ? { payload: { ...record.payload } } : {}),
        ...(record.action ? { action: { ...record.action } } : {}),
    };
}
//# sourceMappingURL=InMemoryNotificationStore.js.map