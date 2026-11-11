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

import { NOTIFICATION_MAX_PER_USER } from './constants';
import type { NotificationStore } from './NotificationStore';
import type { NotificationRecord } from './types';

export interface InMemoryNotificationStoreOpts {
    /** Defaults to NOTIFICATION_MAX_PER_USER (200). */
    maxPerUser?: number;
}

export class InMemoryNotificationStore implements NotificationStore {
    private readonly maxPerUser: number;
    /** userId → id → record (Map keeps insertion order; `list` sorts by timestamp). */
    private readonly inboxes = new Map<string, Map<string, NotificationRecord>>();

    constructor(opts: InMemoryNotificationStoreOpts = {}) {
        const max = opts.maxPerUser ?? NOTIFICATION_MAX_PER_USER;
        if (!Number.isSafeInteger(max) || max < 1) throw new Error('InMemoryNotificationStore: maxPerUser must be a positive integer');
        this.maxPerUser = max;
    }

    async append(userId: string, record: NotificationRecord): Promise<void> {
        if (!userId || !record || typeof record.id !== 'string' || !record.id) return;
        let inbox = this.inboxes.get(userId);
        if (!inbox) { inbox = new Map(); this.inboxes.set(userId, inbox); }
        const previous = inbox.get(record.id);
        const read = record.read ?? previous?.read;
        inbox.set(record.id, { ...copy(record), ...(read !== undefined ? { read } : {}) });
        if (inbox.size > this.maxPerUser) {
            for (const r of this.sorted(inbox).slice(0, inbox.size - this.maxPerUser)) inbox.delete(r.id);
        }
    }

    async list(userId: string): Promise<NotificationRecord[]> {
        const inbox = this.inboxes.get(userId);
        return inbox ? this.sorted(inbox).map(copy) : [];
    }

    async listUnread(userId: string): Promise<NotificationRecord[]> {
        return (await this.list(userId)).filter((n) => !n.read);
    }

    async markRead(userId: string, id: string): Promise<void> {
        const record = this.inboxes.get(userId)?.get(id);
        if (record) record.read = true;
    }

    async markAllRead(userId: string): Promise<string[]> {
        const inbox = this.inboxes.get(userId);
        if (!inbox) return [];
        const ids: string[] = [];
        for (const record of this.sorted(inbox)) { record.read = true; ids.push(record.id); }
        return ids;
    }

    async remove(userId: string, id: string): Promise<boolean> {
        const inbox = this.inboxes.get(userId);
        if (!inbox?.delete(id)) return false;
        if (inbox.size === 0) this.inboxes.delete(userId);
        return true;
    }

    /** Forget every user's inbox (a host rebuilding from its own records). */
    clear(): void {
        this.inboxes.clear();
    }

    private sorted(inbox: Map<string, NotificationRecord>): NotificationRecord[] {
        // Stable: equal timestamps keep insertion order.
        return [...inbox.values()].sort((a, b) => score(a.timestamp) - score(b.timestamp));
    }
}

function score(timestamp: string): number {
    const t = Date.parse(timestamp);
    return Number.isNaN(t) ? 0 : t;
}

function copy(record: NotificationRecord): NotificationRecord {
    return {
        ...record,
        ...(record.payload ? { payload: { ...record.payload } } : {}),
        ...(record.action ? { action: { ...record.action } } : {}),
    };
}
