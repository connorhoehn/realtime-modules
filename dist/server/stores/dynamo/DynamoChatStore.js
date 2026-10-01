"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DynamoChatStore = exports.DEFAULT_DYNAMO_CHAT_TABLES = void 0;
const dmChannels_1 = require("../../../chat/dmChannels");
const common_1 = require("./common");
const DynamoMessagesTable_1 = require("./DynamoMessagesTable");
const DynamoConversationsStore_1 = require("./DynamoConversationsStore");
const DynamoChatMembershipStore_1 = require("./DynamoChatMembershipStore");
const DynamoChatReadReceiptStore_1 = require("./DynamoChatReadReceiptStore");
exports.DEFAULT_DYNAMO_CHAT_TABLES = Object.freeze({
    messages: 'chat-messages',
    conversations: 'chat-conversations',
    members: 'chat-members',
    reads: 'chat-reads',
});
class DynamoChatStore {
    /** `chat-messages` — what the ChatStore methods read and write. */
    messages;
    /** `chat-conversations` — the per-user conversations index. */
    conversations;
    /** `chat-members` — a ChatMembershipStore. */
    members;
    /** `chat-reads` — a ChatReadReceiptStore. */
    reads;
    /** Resolved table names (prefix applied). */
    tables;
    constructor(opts) {
        const client = (0, common_1.requireClient)('DynamoChatStore', opts?.client);
        const prefix = opts.tablePrefix ?? '';
        const t = { ...exports.DEFAULT_DYNAMO_CHAT_TABLES, ...stripUndefined(opts.tables ?? {}) };
        this.tables = Object.freeze({
            messages: prefix + t.messages,
            conversations: prefix + t.conversations,
            members: prefix + t.members,
            reads: prefix + t.reads,
        });
        const clock = { now: opts.now, ttlSeconds: opts.ttlSeconds };
        this.messages = new DynamoMessagesTable_1.DynamoMessagesTable({ client, tableName: this.tables.messages, ...clock });
        this.conversations = new DynamoConversationsStore_1.DynamoConversationsStore({
            client,
            tableName: this.tables.conversations,
            channelIndexName: opts.channelIndexName,
            logger: opts.logger,
            ...clock,
        });
        this.members = new DynamoChatMembershipStore_1.DynamoChatMembershipStore({ client, tableName: this.tables.members });
        this.reads = new DynamoChatReadReceiptStore_1.DynamoChatReadReceiptStore({ client, tableName: this.tables.reads, logger: opts.logger, ...clock });
    }
    putMessage(message) {
        return this.messages.putMessage(message);
    }
    listMessages(channel, limit) {
        return this.messages.listMessages(channel, limit);
    }
    getMessage(channel, messageId) {
        return this.messages.getMessage(channel, messageId);
    }
    updateMessage(channel, messageId, patch) {
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
    chatOptions(extra = {}) {
        const conversations = this.conversations;
        const swallow = () => { };
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
            onMessageChanged(info) {
                const service = this;
                void (async () => {
                    const sender = info.message?.userId;
                    let recipients = [];
                    if (!(0, dmChannels_1.isDmChatChannel)(info.channel)) {
                        if (extra.channelRecipients)
                            recipients = await extra.channelRecipients(info.channel, sender);
                        else if (typeof service?._channelMessageRecipients === 'function') {
                            recipients = await service._channelMessageRecipients(info.channel, sender);
                        }
                    }
                    const members = (0, DynamoConversationsStore_1.changedMessageIndexMembers)(info.channel, sender, recipients);
                    const shown = info.kind === 'deleted' ? { ...info.message, message: 'Message deleted' } : info.message;
                    await conversations.recordMessage({ channel: info.channel, members, message: shown });
                })().catch(swallow);
                extra.onMessageChanged?.call(this, info);
            },
            onChannelJoin(info) {
                void conversations.recordJoin(info.channel, info.userId).catch(swallow);
                extra.onChannelJoin?.call(this, info);
            },
            channelAudience: (channel) => conversations.listUsersForChannel(channel),
        };
    }
}
exports.DynamoChatStore = DynamoChatStore;
function stripUndefined(o) {
    const out = {};
    for (const [k, v] of Object.entries(o))
        if (v !== undefined)
            out[k] = v;
    return out;
}
//# sourceMappingURL=DynamoChatStore.js.map