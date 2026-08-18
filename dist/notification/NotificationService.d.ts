import { RedisNotificationStore } from './RedisNotificationStore';
import type { NotificationRedisClient } from './RedisNotificationStore';
import type { NotificationInput, NotificationRecord, NotificationMessageRouter, NotificationLogger } from './types';
export interface NotificationServiceOpts {
    messageRouter: NotificationMessageRouter;
    logger: NotificationLogger;
    /**
     * Redis client (node-redis v4). When null the service still delivers to
     * live tabs but persistence + replay are no-ops. Either pass a client or
     * a pre-built store; the store wins if both are given.
     */
    redisClient?: NotificationRedisClient | null;
    /** Pre-built store (tests inject a fake here). */
    store?: RedisNotificationStore;
}
export declare class NotificationService {
    private readonly messageRouter;
    private readonly logger;
    private readonly store;
    constructor(opts: NotificationServiceOpts);
    /**
     * Publish a notification to a user. Persists it (Redis) then delivers a
     * `notification:new` frame to every live connection of that user.
     * Returns the stored record (with the server-assigned id/timestamp) and
     * the number of live connections it reached. Never throws — delivery
     * failures are logged.
     */
    notifyUser(userId: string, input: NotificationInput): Promise<{
        record: NotificationRecord;
        delivered: number;
    }>;
    handleAction(clientId: string, action: string, data: any): Promise<void>;
    private handleMarkRead;
    private handleMarkAllRead;
    private handleGetHistory;
    /**
     * Send the just-connected tab its UNREAD notification set as a single
     * `notification:bulk-update` frame. Scoped to ONE clientId (the new tab),
     * not fanned out — the user's other tabs already have their state.
     * Best-effort; no-op when the user has no unread items.
     */
    replayUnreadForUser(clientId: string, userId: string): Promise<void>;
    /**
     * Resolve every live clientId for `userId` and deliver `frame` to each.
     * Returns the count of clients we attempted delivery to. We pass '' as
     * the exclude so ALL of the user's tabs receive it — a notification
     * targets the user, not a peer, so there's no sender to exclude here
     * (markRead echoes deliberately include the originating tab).
     */
    private deliverToUser;
    /**
     * Resolve the authed userId for an inbound action. The router's reverse
     * lookup (`getUserIdForClient`, cross-node-aware) is AUTHORITATIVE and
     * checked first — a client-supplied `data.userId` is spoofable, so it's
     * only a fallback for test harnesses / routers that don't expose the
     * reverse lookup. This prevents one user from marking another's
     * notifications read.
     */
    private resolveUserId;
    private sendErrorToClient;
}
//# sourceMappingURL=NotificationService.d.ts.map