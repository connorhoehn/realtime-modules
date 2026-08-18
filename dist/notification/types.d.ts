/**
 * Semantic category of a notification. Mirrors the hook's
 * `NotificationType` union but typed as a plain string here so producers
 * (platform-api, operators) aren't forced to recompile against a new
 * gateway build every time the union grows. The hook coerces unknown
 * values through `asNotification` without rejecting them.
 */
export type NotificationType = 'mention' | 'reply' | 'approval-requested' | 'approval-resolved' | 'file-scan' | 'system' | string;
/**
 * A single user-scoped notification. Matches the hook's `Notification`
 * interface field-for-field (useNotifications.ts:52-71). `read` is carried
 * server-side so the bulk-update replay on connect can pre-mark entries the
 * user already dismissed on another tab.
 */
export interface NotificationRecord {
    /** Stable unique id. Generated server-side when the producer omits it. */
    id: string;
    /** Semantic category. */
    type: NotificationType;
    /** Short headline. */
    title: string;
    /** Optional longer body text. */
    body?: string;
    /** ISO 8601 timestamp of when the event occurred. */
    timestamp: string;
    /** Whether the user has read this notification. */
    read?: boolean;
    /** Origin channel — used by the app for click-to-navigate. */
    channel?: string;
    /** Arbitrary structured payload for extensibility. */
    payload?: Record<string, unknown>;
    /** Optional CTA the app can render as a button/link. */
    action?: {
        label: string;
        href?: string;
        onClickEvent?: string;
    };
}
/**
 * The producer-facing input shape for {@link NotificationService.notifyUser}.
 * `id` + `timestamp` are optional — the service fills them in when omitted so
 * callers don't have to generate ids or clocks.
 */
export interface NotificationInput {
    id?: string;
    type: NotificationType;
    title: string;
    body?: string;
    timestamp?: string;
    read?: boolean;
    channel?: string;
    payload?: Record<string, unknown>;
    action?: {
        label: string;
        href?: string;
        onClickEvent?: string;
    };
}
export interface NotificationNewFrame {
    type: 'notification:new';
    service: 'notification';
    payload: NotificationRecord;
}
export interface NotificationReadFrame {
    type: 'notification:read';
    service: 'notification';
    payload: {
        id: string;
    };
}
export interface NotificationBulkUpdateFrame {
    type: 'notification:bulk-update';
    service: 'notification';
    payload: {
        notifications: NotificationRecord[];
    };
}
export type NotificationFrame = NotificationNewFrame | NotificationReadFrame | NotificationBulkUpdateFrame;
/**
 * The slice of MessageRouter the notification service needs. Mirrors the
 * seam CallService uses: resolve a user's connected clientIds, then send to
 * each (cross-node routing happens transparently inside `sendToClient`).
 */
export interface NotificationMessageRouter {
    /**
     * Resolve every connected client authenticated as one of `userIds`.
     * Redis-backed + async in production; may return cross-node clients too.
     * `excludeClientId` is honoured by the router (we pass '' to include all
     * of the user's tabs — notifications target the user, not a peer).
     */
    getClientsByUserId(userIds: string[], excludeClientId: string): Promise<Array<{
        clientId: string;
        userId: string;
    }>> | Array<{
        clientId: string;
        userId: string;
    }>;
    /** Deliver a frame to a single client (routes cross-node when needed). */
    sendToClient(clientId: string, message: unknown): Promise<boolean> | boolean;
    /** Optional sync local-liveness probe (true=live, false=dead, null=peer). */
    isClientLive?(clientId: string): boolean | null;
}
export interface NotificationLogger {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
    debug?(message: string, meta?: Record<string, unknown>): void;
}
//# sourceMappingURL=types.d.ts.map