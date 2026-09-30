import type { ChatMessage } from '../../../chat/types';
import { type DynamoCommandClient, type DynamoStoreClockOpts, type DynamoStoreLogger } from './common';
/** First this many characters of a message become the row's preview. */
export declare const CONVERSATION_PREVIEW_MAX = 140;
/** GSI on `chat-conversations` keyed by `channel`. */
export declare const CONVERSATIONS_CHANNEL_INDEX = "channel-index";
export interface ConversationRow {
    userId: string;
    channel: string;
    peers: string[];
    lastMessageAt: string;
    lastMessagePreview: string;
    lastMessageUserId: string | null;
    /** This person keeps the thread at the top of their list. */
    pinned?: boolean;
    /** ISO-8601. Absent or null: not muted. */
    mutedUntil?: string | null;
    /** ISO-8601: marked unread from this message's time. */
    unreadFrom?: string | null;
    /** A free-text label this person filed the thread under. */
    section?: string | null;
}
/** What one person can change about their own view of a conversation. */
export interface ConversationStatePatch {
    pinned?: boolean;
    mutedUntil?: string | null;
    unreadFrom?: string | null;
    section?: string | null;
}
export interface DynamoConversationsStoreOpts extends DynamoStoreClockOpts {
    client: DynamoCommandClient;
    tableName: string;
    /** GSI keyed by `channel`. Default `channel-index`. */
    channelIndexName?: string;
    logger?: DynamoStoreLogger;
}
/**
 * Who a conversations-index write is for when a message CHANGES (edited,
 * deleted, or a card patched in place by the server).
 *
 * `recordMessage` writes `peers = members` on every member's row, so
 * `members` is also what each row will say the conversation is BETWEEN. A DM
 * edit that passed only the sender rewrote the sender's row to
 * `peers: [sender]` and the rail lost the other person. A DM's members are
 * its name — the rule the send path uses; a hashed group DM (`chat:dmg:`)
 * cannot be read back from its name, so it writes nothing, as its sends do.
 */
export declare function changedMessageIndexMembers(channel: string, sender: string | undefined, channelRecipients: readonly string[]): string[];
export declare class DynamoConversationsStore {
    private readonly client;
    readonly tableName: string;
    readonly channelIndexName: string;
    private readonly logger?;
    private readonly now;
    private readonly ttlSeconds;
    constructor(opts: DynamoConversationsStoreOpts);
    /**
     * Upsert the row for EVERY member of the thread with the message's
     * preview and recency. Failures are logged and swallowed per member.
     */
    recordMessage(info: {
        channel: string;
        members: string[];
        message: ChatMessage;
    }): Promise<void>;
    /**
     * A message the server posted (`ChatService.postSystemMessage` — a
     * document card, a call card) is conversation traffic too, but no chat
     * hook sees it. Call this with what postSystemMessage resolved. DMs only,
     * members from the channel's name; channels are indexed from their sends.
     */
    recordSystemMessage(channel: string, posted: ChatMessage | null | undefined): Promise<void>;
    /**
     * A user joined a channel: make sure their row exists so the channel's
     * audience includes them. Idempotent; never touches preview or recency.
     */
    recordJoin(channel: string, userId: string): Promise<void>;
    setPinned(userId: string, channel: string, pinned: boolean): Promise<ConversationRow>;
    /** Mute until `mutedUntil` (ISO), or `null` to unmute. */
    setMuted(userId: string, channel: string, mutedUntil: string | null): Promise<ConversationRow>;
    /** Mark unread from a message's time, or `null` to clear it. */
    setUnreadFrom(userId: string, channel: string, unreadFrom: string | null): Promise<ConversationRow>;
    /** File the thread under this label, or `null` for the default grouping. */
    setSection(userId: string, channel: string, section: string | null): Promise<ConversationRow>;
    /**
     * Any of the four per-person fields in one round trip. `null` REMOVEs the
     * attribute; `peers` and the ttl are seeded the way recordJoin seeds them
     * so a row created by pinning alone is well formed. Creates the row.
     */
    patchState(userId: string, channel: string, patch: ConversationStatePatch): Promise<ConversationRow>;
    /**
     * Which of `userIds` have muted this channel right now. One BatchGetItem
     * per 100 keys, projecting only the instant. Any failure answers
     * "nobody is muted" — a stray notification beats a lost one.
     */
    mutedMembers(channel: string, userIds: readonly string[], now?: Date): Promise<Set<string>>;
    /**
     * Everyone with a row for the channel (joined it, or was sent a message
     * in it), from the `channel-index` GSI. A table without the index answers
     * [] and logs — suitable as ChatService's `channelAudience`.
     */
    listUsersForChannel(channel: string, limit?: number): Promise<string[]>;
    /** All conversations for a user, newest activity first. */
    listForUser(userId: string, limit?: number): Promise<ConversationRow[]>;
}
export declare function conversationRowFromItem(item: Record<string, any>, userId: string, channel?: string): ConversationRow;
//# sourceMappingURL=DynamoConversationsStore.d.ts.map