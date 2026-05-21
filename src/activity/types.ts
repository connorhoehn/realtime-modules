// realtime-modules/src/activity/types.ts
//
// Wire-shape types for the activity-feed feature. These are the canonical
// envelope shapes the lifted ActivityService emits/consumes — adapters in
// consumer services must round-trip them byte-for-byte.

/**
 * Enriched activity event payload — what subscribers of an activity
 * channel see on the `activity:event` frame, and what the durable
 * `activity.recorded` event carries.
 *
 * Field semantics (preserved verbatim from gateway origin):
 *   - `eventType`: required client-supplied string (e.g. `doc.created`).
 *   - `detail`: free-form object; the activity service does not interpret
 *     it. Defaults to `{}` if the publisher omitted it.
 *   - `timestamp`: server-stamped ISO-8601 string. NOT trusted from the
 *     publisher.
 *   - `userId`: derived from `clientData.userContext.userId`; null when
 *     anonymous.
 *   - `displayName`: best-effort label — `metadata.displayName ??
 *     userContext.displayName ?? userContext.username ?? userId ??
 *     'anonymous'`.
 */
export interface ActivityEvent {
    eventType: string;
    detail: Record<string, unknown>;
    timestamp: string;
    userId: string | null;
    displayName: string;
}

/**
 * Tunable knobs for ActivityService. All optional; defaults mirror
 * gateway/src/config/constants.ts at extraction time.
 */
export interface ActivityEventConfig {
    /** Max history items kept per channel by the history store. Default 200. */
    maxHistoryItems?: number;
    /** Bounded retry count for the optional durable-publish hook. Default 3. */
    publishMaxAttempts?: number;
    /** Exponential-backoff base for the retry loop, in ms. Default 50. */
    publishBackoffBaseMs?: number;
    /** Max length of a subscribe/unsubscribe channelId. Default 100. */
    maxChannelIdLength?: number;
}
