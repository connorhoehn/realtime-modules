export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export interface GatewayError {
    code: string;
    message: string;
    timestamp: string;
}
export interface GatewayMessage {
    type: string;
    action?: string;
    channel?: string;
    error?: GatewayError;
    [key: string]: unknown;
}
/**
 * Minimal WebSocket facade required by useYjsDoc.
 * Mirrors frontend's UseWebSocketReturn — feel free to satisfy structurally.
 */
export interface UseWebSocketReturn {
    connectionState: ConnectionState;
    lastError: GatewayError | null;
    sessionToken: string | null;
    clientId: string | null;
    currentChannel: string;
    switchChannel: (channel: string) => void;
    sendMessage: (msg: Record<string, unknown>) => void;
    disconnect: () => void;
    reconnect: () => void;
}
/** A persisted chat message — mirror of gateway/chat/types.ts ChatMessage. */
export interface ChatMessage {
    id: string;
    clientId: string;
    /**
     * Authenticated user id of the sender (auth subject, stable across
     * reconnects) — distinct from the per-connection `clientId`. Present
     * only when the server's ChatService runs an identityResolver.
     */
    userId?: string;
    channel: string;
    message: string;
    metadata?: Record<string, unknown>;
    timestamp: string;
    /** ISO: the author changed the text after sending. */
    editedAt?: string;
    /** ISO: the author took it back; text is empty and metadata is {deleted:true}. */
    deletedAt?: string;
}
/** Presence status values accepted by the gateway's presence service. */
export type PresenceStatus = 'online' | 'away' | 'busy' | 'offline';
/**
 * One presence entry — mirror of gateway/presence/types.ts PresenceEntry.
 * Field set is preserved verbatim so the WS wire surface stays byte-identical.
 */
export interface PresenceEntry {
    clientId: string;
    status: PresenceStatus;
    metadata: Record<string, unknown>;
    channels: string[];
    nodeId: string;
    timestamp: string;
    lastSeen: string;
    lastHeartbeat: number;
}
/** One reaction event — mirror of gateway/reactions/types.ts Reaction. */
export interface Reaction {
    id: string;
    clientId: string;
    channel: string;
    emoji: string;
    effect: string;
    position: unknown;
    metadata: Record<string, unknown>;
    timestamp: string;
    /** Optional entity being reacted to (messageId, articleId, commentId, …). */
    targetId?: string;
    /**
     * Stable owner id, stamped server-side from the connection's authenticated
     * context (never from the frame). Absent when the server resolved no
     * identity. This — not `clientId` — is what makes "you already reacted"
     * answerable across a reload, so grouping and toggling both key on it.
     */
    userId?: string;
    /** Owner's display name, stamped alongside `userId`. */
    displayName?: string;
}
/** One activity event — mirror of gateway/activity/types.ts ActivityEvent. */
export interface ActivityEvent {
    eventType: string;
    detail: Record<string, unknown>;
    timestamp: string;
    userId: string | null;
    displayName: string;
}
/**
 * One live cursor — post-parse mirror of cursor/types.ts CursorData, which is
 * what CursorService stores and broadcasts. `position` is mode-dependent:
 * `{x,y}` for freeform/canvas, `{row,col}` for table, `{position}` for text.
 * The service stamps `mode`, `userInitials` and `userColor` into metadata on
 * every update, so an overlay can render a labelled cursor with no extra
 * lookup.
 */
export interface CursorEntry {
    clientId: string;
    channel: string;
    position: Record<string, unknown>;
    metadata: Record<string, unknown> & {
        mode: string;
        userInitials: string;
        userColor: string;
    };
    /** ISO-8601 — when the sender generated this position. */
    timestamp: string;
}
//# sourceMappingURL=types.d.ts.map