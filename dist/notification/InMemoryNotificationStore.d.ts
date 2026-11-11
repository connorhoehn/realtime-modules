import type { NotificationStore } from './NotificationStore';
import type { NotificationRecord } from './types';
export interface InMemoryNotificationStoreOpts {
    /** Defaults to NOTIFICATION_MAX_PER_USER (200). */
    maxPerUser?: number;
}
export declare class InMemoryNotificationStore implements NotificationStore {
    private readonly maxPerUser;
    /** userId → id → record (Map keeps insertion order; `list` sorts by timestamp). */
    private readonly inboxes;
    constructor(opts?: InMemoryNotificationStoreOpts);
    append(userId: string, record: NotificationRecord): Promise<void>;
    list(userId: string): Promise<NotificationRecord[]>;
    listUnread(userId: string): Promise<NotificationRecord[]>;
    markRead(userId: string, id: string): Promise<void>;
    markAllRead(userId: string): Promise<string[]>;
    remove(userId: string, id: string): Promise<boolean>;
    /** Forget every user's inbox (a host rebuilding from its own records). */
    clear(): void;
    private sorted;
}
//# sourceMappingURL=InMemoryNotificationStore.d.ts.map