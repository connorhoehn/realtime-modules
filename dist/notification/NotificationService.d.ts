import { RedisNotificationStore } from './RedisNotificationStore';
import type { FeaturePrincipal } from '../server/authority/principal';
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
    /** Awaited before inbound history/read-state work. False, throw or
     * rejection refuses the action. Recipient delivery filtering belongs to
     * the router so it also covers producer delivery and connect replay. */
    authorize?: (clientId: string, action: string) => boolean | Promise<boolean>;
    /**
     * READ ADMISSION (0.118). Asked FRESH for every record at every delivery
     * (`notifyUser` fan-out, connect replay, `getHistory`) — never cached: may
     * `userId` be shown `record` right now? The host answers from its read
     * authority (e.g. "may this person still read the page this item is
     * about"). False, a throw or a rejection withholds the record from that
     * delivery; it stays stored, and a later delivery asks again.
     */
    admit?: (userId: string, record: NotificationRecord) => boolean | Promise<boolean>;
    /**
     * Replay the user's unread inbox to each new connection, once per
     * connection, through `admit`. Replaces a host `onConnect` that called
     * `replayUnreadForUser`.
     */
    replayOnConnect?: boolean;
    /**
     * The connection's principal (set by `attachRealtime({ principal })`).
     * Checked per connection before and, with `recheckAfterIo`, after
     * admission, so a session whose epoch moved mid-delivery gets nothing.
     */
    principal?: FeaturePrincipal;
}
export declare class NotificationService {
    private readonly messageRouter;
    private readonly logger;
    private readonly store;
    private readonly authorize;
    private readonly admit;
    private readonly replayOnConnect;
    private readonly principal;
    /** Connections already replayed once (cleared on disconnect). */
    private readonly replayed;
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
    /**
     * Server-side read (0.115): the host marks `ids` read for `userId` — say,
     * a "new messages" item once that person has read the thread — exactly as
     * if one of their tabs had sent `markRead`: persisted, then echoed as one
     * `notification:read` per id to every live tab. Unknown ids are harmless.
     */
    markReadForUser(userId: string, ids: readonly string[]): Promise<void>;
    /** The user's stored notifications, oldest first, read state reconciled (0.115: for host-side reads such as an unread index). */
    listForUser(userId: string): Promise<NotificationRecord[]>;
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
    /** WsService connect hook: with `replayOnConnect`, one replay per connection, off the connect path. */
    onClientConnect(clientId: string): Promise<void>;
    onClientDisconnect(clientId: string): Promise<void>;
    /** Fresh read admission for one record; no `admit` hook admits (legacy behaviour). Fails closed. */
    private admitted;
    private admitAll;
    /** Is the connection's principal current? (`after`: only when the principal asks for a recheck after I/O.) */
    private clientCurrent;
    /**
     * Resolve every live clientId for `userId` and deliver `frame` to each.
     * Returns the count of successful deliveries (false suppresses/counts
     * nothing; legacy void-returning routers count as success). We pass '' as
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