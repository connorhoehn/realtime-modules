// realtime-modules/src/server/stores/dynamo/DynamoChatStore.ts
//
// Durable chat over DynamoDB — one object for the four chat tables
// realtime-examples' gateway already writes, so a consumer passes
//
//     chat({ chatStore: new DynamoChatStore({ client }) })
//
// for messages alone, or `chat(store.chatOptions())` for messages +
// membership + read receipts + the conversations index the rail reads.
//
// Every table, key, attribute and TTL matches realtime-examples'
// DdbChatStore / DdbConversationsStore / DdbChatMembershipStore /
// DdbChatReadReceiptsStore and the index maintenance its server.ts wires on
// the ChatService hooks, so that app can swap to this with no migration
// (test/stores/dynamo/app-parity.test.ts proves the commands are identical).
//
// The AWS SDK is an optional peer: this module imports the command classes
// from `@aws-sdk/client-dynamodb`, and the consumer injects the client.

import type { ChatStore } from '../../../chat/ChatStore';
import type { ChatServiceOpts } from '../../../chat/ChatService';
import type { ChatMessage, ChatMessagePatch } from '../../../chat/types';
import { isDmChatChannel } from '../../../chat/dmChannels';
import { requireClient, type DynamoCommandClient, type DynamoStoreClockOpts, type DynamoStoreLogger } from './common';
import { DynamoMessagesTable } from './DynamoMessagesTable';
import { changedMessageIndexMembers, DynamoConversationsStore } from './DynamoConversationsStore';
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

export const DEFAULT_DYNAMO_CHAT_TABLES: Required<DynamoChatTables> = Object.freeze({
    messages: 'chat-messages',
    conversations: 'chat-conversations',
    members: 'chat-members',
    reads: 'chat-reads',
});

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

type HookInfo = { channel: string; members: string[]; message: ChatMessage };
type ChangedInfo = { channel: string; kind: 'edited' | 'deleted'; message: ChatMessage };

/** Extra behaviour to run beside the index maintenance (notifications, say). */
export interface DynamoChatOptionsExtra {
    onDmMessage?: (info: HookInfo) => void;
    onChannelMessage?: (info: HookInfo) => void;
    onMessageChanged?: (info: ChangedInfo) => void;
    onChannelJoin?: (info: { channel: string; userId: string }) => void;
    /**
     * Who a non-DM edit/delete re-indexes, sender excluded. Default: the
     * ChatService's own recipient rule (closed channel: active members; open
     * channel: subscribers + the conversations index audience) — the rule
     * realtime-examples' onMessageChanged reads.
     */
    channelRecipients?: (channel: string, senderUserId: string | undefined) => Promise<string[]> | string[];
}

/** What `chatOptions()` returns — spread into `chat({...})` or `new ChatService({...})`. */
export type DynamoChatOptions = Required<Pick<ChatServiceOpts,
    'chatStore' | 'membershipStore' | 'readReceiptStore'
    | 'onDmMessage' | 'onChannelMessage' | 'onMessageChanged' | 'onChannelJoin' | 'channelAudience'>>;

export class DynamoChatStore implements ChatStore {
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

    constructor(opts: DynamoChatStoreOpts) {
        const client = requireClient('DynamoChatStore', opts?.client);
        const prefix = opts.tablePrefix ?? '';
        const t = { ...DEFAULT_DYNAMO_CHAT_TABLES, ...stripUndefined(opts.tables ?? {}) };
        this.tables = Object.freeze({
            messages: prefix + t.messages,
            conversations: prefix + t.conversations,
            members: prefix + t.members,
            reads: prefix + t.reads,
        });
        const clock = { now: opts.now, ttlSeconds: opts.ttlSeconds };
        this.messages = new DynamoMessagesTable({ client, tableName: this.tables.messages, ...clock });
        this.conversations = new DynamoConversationsStore({
            client,
            tableName: this.tables.conversations,
            channelIndexName: opts.channelIndexName,
            logger: opts.logger,
            ...clock,
        });
        this.members = new DynamoChatMembershipStore({ client, tableName: this.tables.members });
        this.reads = new DynamoChatReadReceiptStore({ client, tableName: this.tables.reads, logger: opts.logger, ...clock });
    }

    putMessage(message: ChatMessage): Promise<void> {
        return this.messages.putMessage(message);
    }

    listMessages(channel: string, limit: number): Promise<ChatMessage[]> {
        return this.messages.listMessages(channel, limit);
    }

    getMessage(channel: string, messageId: string): Promise<ChatMessage | null> {
        return this.messages.getMessage(channel, messageId);
    }

    updateMessage(channel: string, messageId: string, patch: ChatMessagePatch): Promise<ChatMessage | null> {
        return this.messages.updateMessage(channel, messageId, patch);
    }

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
    chatOptions(extra: DynamoChatOptionsExtra = {}): DynamoChatOptions {
        const conversations = this.conversations;
        const swallow = (): void => { /* logged inside */ };
        return {
            chatStore: this,
            membershipStore: this.members,
            readReceiptStore: this.reads,
            onDmMessage(info) {
                void conversations.recordMessage(info).catch(swallow);
                extra.onDmMessage?.call(this, info);
            },
            onChannelMessage(info) {
                const sender = info.message?.userId;
                const members = Array.from(new Set([...(sender ? [sender] : []), ...info.members]));
                void conversations.recordMessage({ ...info, members }).catch(swallow);
                extra.onChannelMessage?.call(this, info);
            },
            // A plain function, not an arrow: ChatService invokes its hooks as
            // methods, so `this` is the service and its recipient rule is
            // reachable without the caller threading the instance through.
            onMessageChanged(this: unknown, info) {
                const service = this as { _channelMessageRecipients?: (c: string, s: string | undefined) => Promise<string[]> } | undefined;
                void (async () => {
                    const sender = info.message?.userId;
                    let recipients: string[] = [];
                    if (!isDmChatChannel(info.channel)) {
                        if (extra.channelRecipients) recipients = await extra.channelRecipients(info.channel, sender);
                        else if (typeof service?._channelMessageRecipients === 'function') {
                            recipients = await service._channelMessageRecipients(info.channel, sender);
                        }
                    }
                    const members = changedMessageIndexMembers(info.channel, sender, recipients);
                    const shown = info.kind === 'deleted' ? { ...info.message, message: 'Message deleted' } : info.message;
                    await conversations.recordMessage({ channel: info.channel, members, message: shown });
                })().catch(swallow);
                extra.onMessageChanged?.call(this, info);
            },
            onChannelJoin(info) {
                void conversations.recordJoin(info.channel, info.userId).catch(swallow);
                extra.onChannelJoin?.call(this, info);
            },
            channelAudience: (channel: string) => conversations.listUsersForChannel(channel),
        };
    }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
    const out: Partial<T> = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as any)[k] = v;
    return out;
}
