export type NotificationType = 'mention' | 'reply' | 'approval-requested' | 'approval-resolved' | 'file-scan' | 'system';
export interface Notification {
    /** Stable unique identifier emitted by the gateway. */
    id: string;
    /** Semantic notification category. */
    type: NotificationType;
    /** Short headline shown in notification UIs. */
    title: string;
    /** Optional longer body text. */
    body?: string;
    /** ISO 8601 timestamp of when the event occurred. */
    timestamp: string;
    /** Whether the user has read this notification. */
    read?: boolean;
    /** Origin channel — used by the app for click-to-navigate behaviour. */
    channel?: string;
    /** Arbitrary structured payload for extensibility. */
    payload?: Record<string, unknown>;
    /** Optional CTA that the app can render as a button or link. */
    action?: {
        label: string;
        href?: string;
        onClickEvent?: string;
    };
}
export interface UseNotificationsOptions {
    /**
     * Maximum number of notifications kept in memory. When this limit is
     * exceeded the oldest (earliest timestamp) entry is dropped.
     * @default 100
     */
    maxNotifications?: number;
    /**
     * localStorage key under which read-state is persisted.
     * @default 'rmn:notifications:read'
     */
    storageKey?: string;
}
export interface UseNotificationsResult {
    /** All in-memory notifications, oldest first. */
    notifications: Notification[];
    /** Count of notifications where `read !== true`. */
    unreadCount: number;
    /** Mark a single notification as read. No-op if id not found. */
    markAsRead(id: string): void;
    /** Mark every notification as read. */
    markAllRead(): void;
    /** Remove a single notification from the list. */
    remove(id: string): void;
    /** Remove all notifications from the list and clear persisted read-state. */
    clearAll(): void;
}
/**
 * useNotifications — subscribe to app-level gateway notification frames.
 *
 * Must be called inside a {@link GatewaySocketProvider}.
 *
 * ```tsx
 * const { notifications, unreadCount, markAsRead } = useNotifications();
 * ```
 */
export declare function useNotifications(options?: UseNotificationsOptions): UseNotificationsResult;
//# sourceMappingURL=useNotifications.d.ts.map