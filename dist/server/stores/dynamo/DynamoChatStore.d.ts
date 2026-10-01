import type { ChatStore } from '../../../chat/ChatStore';
import type { ChatServiceOpts } from '../../../chat/ChatService';
import type { ChatMessage, ChatMessagePatch } from '../../../chat/types';
import { type DynamoCommandClient, type DynamoStoreClockOpts, type DynamoStoreLogger } from './common';
import { DynamoMessagesTable } from './DynamoMessagesTable';
import { DynamoConversationsStore } from './DynamoConversationsStore';
import { DynamoChatMembershipStore } from './DynamoChatMembershipStore';
import { DynamoChatReadReceiptStore } from './DynamoChatReadReceiptStore';
/** Table names. Each defaults to realtime-examples' name. */
export interface DynamoChatTables {
    /** Default `chat-messages` (PK `channelId`, SK `messageId`). */
    messages?: string;
    /** Default `chat-conversations` (PK `userId`, SK `channel`, GSI `channel-index` on `channel`). */
    conversations?: string;
    /** Default `chat-members` (PK `channel`, SK `userId`). */
    members?: string;
    /** Default `chat-reads` (PK `channel`, SK `userId`). */
    reads?: string;
}
export declare const DEFAULT_DYNAMO_CHAT_TABLES: Required<DynamoChatTables>;
export interface DynamoChatStoreOpts extends DynamoStoreClockOpts {
    /** AWS SDK v3 `DynamoDBClient` or `DynamoDBDocumentClient` — anything with `send`. */
    client: DynamoCommandClient;
    /** Table names; any left out take the default. */
    tables?: DynamoChatTables;
    /**
     * Prepended to every table name, given or defaulted — realtime-examples'
     * `DDB_TABLE_PREFIX`. Default ''.
     */
    tablePrefix?: string;
    /** GSI on the conversations table keyed by `channel`. Default `channel-index`. */
    channelIndexName?: string;
    /** Index-write and lookup failures are reported here (they never throw). */
    logger?: DynamoStoreLogger;
}
type HookInfo = {
    channel: string;
    members: string[];
    message: ChatMessage;
};
type ChangedInfo = {
    channel: string;
    kind: 'edited' | 'deleted';
    message: ChatMessage;
};
/** Extra behaviour to run beside the index maintenance (notifications, say). */
export interface DynamoChatOptionsExtra {
    onDmMessage?: (info: HookInfo) => void;
    onChannelMessage?: (info: HookInfo) => void;
    onMessageChanged?: (info: ChangedInfo) => void;
    onChannelJoin?: (info: {
        channel: string;
        userId: string;
    }) => void;
    /**
     * Who a non-DM edit/delete re-indexes, sender excluded. Default: the
     * ChatService's own recipient rule (closed channel: active members; open
     * channel: subscribers + the conversations index audience) — the rule
     * realtime-examples' onMessageChanged reads.
     */
    channelRecipients?: (channel: string, senderUserId: string | undefined) => Promise<string[]> | string[];
}
/** What `chatOptions()` returns — spread into `chat({...})` or `new ChatService({...})`. */
export type DynamoChatOptions = Required<Pick<ChatServiceOpts, 'chatStore' | 'membershipStore' | 'readReceiptStore' | 'onDmMessage' | 'onChannelMessage' | 'onMessageChanged' | 'onChannelJoin' | 'channelAudience'>>;
export declare class DynamoChatStore implements ChatStore {
    /** `chat-messages` — what the ChatStore methods read and write. */
    readonly messages: DynamoMessagesTable;
    /** `chat-conversations` — the per-user conversations index. */
    readonly conversations: DynamoConversationsStore;
    /** `chat-members` — a ChatMembershipStore. */
    readonly members: DynamoChatMembershipStore;
    /** `chat-reads` — a ChatReadReceiptStore. */
    readonly reads: DynamoChatReadReceiptStore;
    /** Resolved table names (prefix applied). */
    readonly tables: Readonly<Required<DynamoChatTables>>;
    constructor(opts: DynamoChatStoreOpts);
    putMessage(message: ChatMessage): Promise<void>;
    listMessages(channel: string, limit: number): Promise<ChatMessage[]>;
    getMessage(channel: string, messageId: string): Promise<ChatMessage | null>;
    updateMessage(channel: string, messageId: string, patch: ChatMessagePatch): Promise<ChatMessage | null>;
    /**
     * Everything ChatService needs for durable chat with a conversations
     * rail, as realtime-examples wires it:
     *
     *   - chatStore / membershipStore / readReceiptStore — the three tables;
     *   - onDmMessage — index the DM for both members;
     *   - onChannelMessage — index the channel for the sender + recipients;
     *   - onMessageChanged — an edit, a delete, or a server card patched in
     *     place (`updateSystemMessage` → `messageUpdated`) moves the row's
     *     preview. A DM re-indexes BOTH members with the pair as `peers`
     *     (never just the sender); a delete previews "Message deleted";
     *   - onChannelJoin — seed the joiner's row so they are the audience;
     *   - channelAudience — the `channel-index` GSI.
     *
     * Index writes are fire-and-forget; the hooks never throw into a send.
     * `extra` hooks run after the index write is started. Server-posted cards
     * (`postSystemMessage`) have no hook: call
     * `store.conversations.recordSystemMessage(channel, posted)`.
     */
    chatOptions(extra?: DynamoChatOptionsExtra): DynamoChatOptions;
}
export {};
//# sourceMappingURL=DynamoChatStore.d.ts.map