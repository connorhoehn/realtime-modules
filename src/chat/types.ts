// realtime-modules/src/chat/types.ts
//
// Wire-shape types for the chat feature. These are the canonical envelope
// shapes the lifted ChatService emits/consumes — adapters in consumer
// services must round-trip them byte-for-byte.

/**
 * Persisted chat message. Lifted from the implicit shape gateway's
 * chat-service.ts has been writing/reading for ~6 months:
 *
 *   - `id` is the application-generated message id (see
 *     `ChatService.generateMessageId`); doubles as the DynamoDB sort key
 *     (`messageId` attribute) in the gateway DDB adapter.
 *   - `clientId` is the connection id of the sender, NOT the user id. The
 *     gateway authz layer maps it to a user upstream of the service.
 *   - `channel` is the DDB partition key (`channelId` attribute).
 *   - `metadata` is JSON-stringified at the storage boundary and
 *     truncated by `validateMetadata` (key count + serialized size caps).
 *   - `timestamp` is an ISO-8601 string for human readability; the DDB
 *     TTL field is computed at persist time and is NOT part of the
 *     message envelope.
 */
export interface ChatMessage {
    id: string;
    clientId: string;
    channel: string;
    message: string;
    metadata?: Record<string, unknown>;
    timestamp: string;
}

/**
 * Query parameters for retrieving channel history.
 *
 * `limit` is a soft cap — implementations may return fewer (e.g. the LRU
 * cache only holds CHAT_MAX_MESSAGES_PER_CHANNEL entries; an empty DDB
 * table returns 0). Returned messages are chronological (oldest first).
 */
export interface ChatHistoryQuery {
    channel: string;
    limit?: number;
}
