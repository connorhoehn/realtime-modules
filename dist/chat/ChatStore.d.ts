import type { ChatMessage, ChatMessagePatch } from './types';
export interface ChatStore {
    /**
     * Persist `message`. Last writer wins on `(channel, id)`. Adapters
     * decide the TTL policy (DDB adapter mirrors gateway's 90-day TTL;
     * InMemoryChatStore keeps everything until the process exits).
     */
    putMessage(message: ChatMessage): Promise<void>;
    /**
     * Most-recent `limit` messages for `channel`, returned chronological
     * (oldest first). Returns an empty array if the channel is unknown.
     */
    listMessages(channel: string, limit: number): Promise<ChatMessage[]>;
    /**
     * Change a stored message in place — an edit (text, metadata, editedAt)
     * or a soft delete (text '', metadata {deleted:true}, deletedAt). The
     * whole `metadata` replaces the stored one when given. Resolves the
     * updated record, or null when `(channel, messageId)` is unknown.
     */
    updateMessage(channel: string, messageId: string, patch: ChatMessagePatch): Promise<ChatMessage | null>;
}
/**
 * Zero-config in-memory implementation. Intended for:
 *
 *   - unit tests (no DDB-local needed),
 *   - dev mode when shared backing services are off,
 *   - zero-config consumers (embedded use) that don't want AWS.
 *
 * Implementation notes:
 *
 *   - Per-channel arrays kept in insertion (chronological) order. The
 *     gateway's LRU cache inside ChatService still bounds the working set
 *     in front of this store, so unbounded growth here is not a hot path
 *     concern for the tests / dev flows this targets.
 *   - Shallow-clones on put/get so caller mutations don't leak into
 *     storage and vice versa — matches the defensive-copy convention used
 *     in MemorySnapshotStore.
 */
export declare class InMemoryChatStore implements ChatStore {
    private readonly messages;
    putMessage(message: ChatMessage): Promise<void>;
    listMessages(channel: string, limit: number): Promise<ChatMessage[]>;
    updateMessage(channel: string, messageId: string, patch: ChatMessagePatch): Promise<ChatMessage | null>;
    /** Test helper — clears every channel. Not part of ChatStore. */
    _reset(): void;
}
//# sourceMappingURL=ChatStore.d.ts.map