"use strict";
// realtime-modules/src/server/stores/dynamo/DynamoConversationsStore.ts
//
// The `chat-conversations` table — the per-user conversations index the
// conversation rail reads ("which threads does X have, newest activity first,
// with a preview?"), which chat-messages cannot answer (its partition key is
// the channel). A faithful extraction of realtime-examples'
// DdbConversationsStore (src/realtime-fanout/chat/adapters/
// DdbConversationsStore.ts):
//
//   - Partition key: `userId` (S)   — one row per (member, channel)
//   - Sort key:      `channel` (S)
//   - GSI `channel-index` (PK `channel`, projection ALL) — the channel's
//     audience (`listUsersForChannel`)
//   - `peers`              (S, JSON array of member userIds, self included)
//   - `lastMessageAt`      (S, ISO-8601)
//   - `lastMessagePreview` (S, first 140 chars)
//   - `lastMessageUserId`  (S, the sender's userId)
//   - `joinedAt`           (S, ISO-8601, written once by recordJoin)
//   - `pinned` (BOOL), `mutedUntil` (S), `unreadFrom` (S), `section` (S) —
//     PER PERSON; written by the state setters and never touched by a
//     message, which is why recordMessage is an UpdateItem over the message
//     fields rather than a Put of the whole row
//   - `ttl`                (N, epoch seconds, +90 days rolling)
//
// Index writes are best-effort: failures are logged and swallowed, because
// the message itself is already stored and the row heals on the next one.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DynamoConversationsStore = exports.CONVERSATIONS_CHANNEL_INDEX = exports.CONVERSATION_PREVIEW_MAX = void 0;
exports.changedMessageIndexMembers = changedMessageIndexMembers;
exports.conversationRowFromItem = conversationRowFromItem;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const dmChannels_1 = require("../../../chat/dmChannels");
const common_1 = require("./common");
/** First this many characters of a message become the row's preview. */
exports.CONVERSATION_PREVIEW_MAX = 140;
/** GSI on `chat-conversations` keyed by `channel`. */
exports.CONVERSATIONS_CHANNEL_INDEX = 'channel-index';
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
function changedMessageIndexMembers(channel, sender, channelRecipients) {
    if ((0, dmChannels_1.isDmChatChannel)(channel))
        return (0, dmChannels_1.dmChannelMembers)(channel) ?? [];
    return Array.from(new Set([...(sender ? [sender] : []), ...channelRecipients]));
}
class DynamoConversationsStore {
    client;
    tableName;
    channelIndexName;
    logger;
    now;
    ttlSeconds;
    messageIndexWrites;
    constructor(opts) {
        this.client = (0, common_1.requireClient)('DynamoConversationsStore', opts?.client);
        this.tableName = (0, common_1.requireTable)('DynamoConversationsStore', opts.tableName);
        this.channelIndexName = opts.channelIndexName ?? exports.CONVERSATIONS_CHANNEL_INDEX;
        this.logger = opts.logger;
        this.now = opts.now ?? Date.now;
        this.ttlSeconds = opts.ttlSeconds ?? common_1.CHAT_TTL_SECONDS;
        const writes = opts.messageIndexWrites ?? 'each';
        if (writes !== 'each' && writes !== 'transaction')
            throw new Error("DynamoConversationsStore: messageIndexWrites must be 'each' or 'transaction'");
        this.messageIndexWrites = writes;
    }
    /**
     * Upsert the row for EVERY member of the thread with the message's
     * preview and recency. Failures are logged and swallowed per member.
     */
    async recordMessage(info) {
        const { channel, members, message } = info;
        if (!members.length)
            return; // hashed group channels carry no parseable members
        const senderUserId = message.userId ?? null;
        const preview = (message.message ?? '').slice(0, exports.CONVERSATION_PREVIEW_MAX);
        const ttl = (0, common_1.ttlFrom)(this.now, this.ttlSeconds);
        const peersJson = JSON.stringify(members);
        // UpdateItem, not Put: the row also carries this person's own
        // pinned / mutedUntil / unreadFrom / section.
        const update = (userId) => ({
            TableName: this.tableName,
            Key: { userId: { S: userId }, channel: { S: channel } },
            UpdateExpression: 'SET peers = :peers, lastMessageAt = :at, lastMessagePreview = :preview, #ttl = :ttl'
                + (senderUserId ? ', lastMessageUserId = :sender' : ''),
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: {
                ':peers': { S: peersJson },
                ':at': { S: message.timestamp },
                ':preview': { S: preview },
                ':ttl': { N: ttl },
                ...(senderUserId ? { ':sender': { S: senderUserId } } : {}),
            },
        });
        const each = (userIds) => Promise.all(userIds.map(async (userId) => {
            try {
                await this.client.send(new client_dynamodb_1.UpdateItemCommand(update(userId)));
            }
            catch (err) {
                this.logger?.warn?.('conversations index write failed', {
                    channel,
                    userId,
                    error: err?.message,
                });
            }
        }));
        const unique = Array.from(new Set(members));
        if (this.messageIndexWrites !== 'transaction' || unique.length < 2) {
            await each(members);
            return;
        }
        const chunks = [];
        for (let i = 0; i < unique.length; i += 100)
            chunks.push(unique.slice(i, i + 100));
        await Promise.all(chunks.map(async (chunk) => {
            if (chunk.length < 2) {
                await each(chunk);
                return;
            }
            try {
                await this.client.send(new client_dynamodb_1.TransactWriteItemsCommand({
                    TransactItems: chunk.map((userId) => ({ Update: update(userId) })),
                }));
            }
            catch (err) {
                this.logger?.warn?.('conversations index transaction failed; writing rows one by one', {
                    channel,
                    error: err?.message,
                });
                await each(chunk);
            }
        }));
    }
    /**
     * A message the server posted (`ChatService.postSystemMessage` — a
     * document card, a call card) is conversation traffic too, but no chat
     * hook sees it. Call this with what postSystemMessage resolved. DMs only,
     * members from the channel's name; channels are indexed from their sends.
     */
    async recordSystemMessage(channel, posted) {
        if (!posted?.id)
            return;
        const members = changedMessageIndexMembers(channel, undefined, []);
        if (!members.length)
            return;
        await this.recordMessage({ channel, members, message: posted });
    }
    /**
     * A user joined a channel: make sure their row exists so the channel's
     * audience includes them. Idempotent; never touches preview or recency.
     */
    async recordJoin(channel, userId) {
        if (!channel || !userId)
            return;
        const now = new Date(this.now()).toISOString();
        try {
            await this.client.send(new client_dynamodb_1.UpdateItemCommand({
                TableName: this.tableName,
                Key: { userId: { S: userId }, channel: { S: channel } },
                UpdateExpression: 'SET peers = if_not_exists(peers, :peers), joinedAt = if_not_exists(joinedAt, :now), #ttl = :ttl',
                ExpressionAttributeNames: { '#ttl': 'ttl' },
                ExpressionAttributeValues: {
                    ':peers': { S: JSON.stringify([userId]) },
                    ':now': { S: now },
                    ':ttl': { N: (0, common_1.ttlFrom)(this.now, this.ttlSeconds) },
                },
            }));
        }
        catch (err) {
            this.logger?.warn?.('conversations index join write failed', { channel, userId, error: err?.message });
        }
    }
    setPinned(userId, channel, pinned) {
        return this.patchState(userId, channel, { pinned });
    }
    /** Mute until `mutedUntil` (ISO), or `null` to unmute. */
    setMuted(userId, channel, mutedUntil) {
        return this.patchState(userId, channel, { mutedUntil });
    }
    /** Mark unread from a message's time, or `null` to clear it. */
    setUnreadFrom(userId, channel, unreadFrom) {
        return this.patchState(userId, channel, { unreadFrom });
    }
    /** File the thread under this label, or `null` for the default grouping. */
    setSection(userId, channel, section) {
        return this.patchState(userId, channel, { section });
    }
    /**
     * Any of the four per-person fields in one round trip. `null` REMOVEs the
     * attribute; `peers` and the ttl are seeded the way recordJoin seeds them
     * so a row created by pinning alone is well formed. Creates the row.
     */
    async patchState(userId, channel, patch) {
        const sets = ['peers = if_not_exists(peers, :peers)', '#ttl = :ttl'];
        const removes = [];
        const names = { '#ttl': 'ttl' };
        const values = {
            ':peers': { S: JSON.stringify([userId]) },
            ':ttl': { N: (0, common_1.ttlFrom)(this.now, this.ttlSeconds) },
        };
        if (patch.pinned !== undefined) {
            sets.push('pinned = :pinned');
            values[':pinned'] = { BOOL: patch.pinned };
        }
        if (patch.mutedUntil !== undefined) {
            if (patch.mutedUntil === null)
                removes.push('mutedUntil');
            else {
                sets.push('mutedUntil = :mutedUntil');
                values[':mutedUntil'] = { S: patch.mutedUntil };
            }
        }
        if (patch.unreadFrom !== undefined) {
            if (patch.unreadFrom === null)
                removes.push('unreadFrom');
            else {
                sets.push('unreadFrom = :unreadFrom');
                values[':unreadFrom'] = { S: patch.unreadFrom };
            }
        }
        if (patch.section !== undefined) {
            // SECTION is a DynamoDB reserved word — always aliased.
            names['#section'] = 'section';
            if (patch.section === null)
                removes.push('#section');
            else {
                sets.push('#section = :section');
                values[':section'] = { S: patch.section };
            }
        }
        const res = await this.client.send(new client_dynamodb_1.UpdateItemCommand({
            TableName: this.tableName,
            Key: { userId: { S: userId }, channel: { S: channel } },
            UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
        }));
        return conversationRowFromItem(res?.Attributes ?? {}, userId, channel);
    }
    /**
     * Which of `userIds` have muted this channel right now. One BatchGetItem
     * per 100 keys, projecting only the instant. Any failure answers
     * "nobody is muted" — a stray notification beats a lost one.
     */
    async mutedMembers(channel, userIds, now = new Date(this.now())) {
        const muted = new Set();
        const unique = [...new Set(userIds.filter(Boolean))];
        if (!channel || unique.length === 0)
            return muted;
        try {
            for (let i = 0; i < unique.length; i += 100) {
                const chunk = unique.slice(i, i + 100);
                const res = await this.client.send(new client_dynamodb_1.BatchGetItemCommand({
                    RequestItems: {
                        [this.tableName]: {
                            Keys: chunk.map((userId) => ({ userId: { S: userId }, channel: { S: channel } })),
                            ProjectionExpression: 'userId, mutedUntil',
                        },
                    },
                }));
                for (const item of res?.Responses?.[this.tableName] ?? []) {
                    const until = item.mutedUntil?.S;
                    const who = item.userId?.S;
                    if (!who || !until)
                        continue;
                    const at = Date.parse(until);
                    if (Number.isFinite(at) && at > now.getTime())
                        muted.add(who);
                }
            }
        }
        catch (err) {
            this.logger?.warn?.('conversations mute lookup failed', { channel, error: err?.message });
            return new Set();
        }
        return muted;
    }
    /**
     * Everyone with a row for the channel (joined it, or was sent a message
     * in it), from the `channel-index` GSI. A table without the index answers
     * [] and logs — suitable as ChatService's `channelAudience`.
     */
    async listUsersForChannel(channel, limit = 500) {
        try {
            const out = [];
            let ExclusiveStartKey;
            do {
                const res = await this.client.send(new client_dynamodb_1.QueryCommand({
                    TableName: this.tableName,
                    IndexName: this.channelIndexName,
                    KeyConditionExpression: 'channel = :c',
                    ExpressionAttributeValues: { ':c': { S: channel } },
                    ProjectionExpression: 'userId',
                    Limit: Math.min(limit, 500),
                    ...(ExclusiveStartKey ? { ExclusiveStartKey: ExclusiveStartKey } : {}),
                }));
                for (const item of res?.Items ?? [])
                    if (item.userId?.S)
                        out.push(item.userId.S);
                ExclusiveStartKey = res?.LastEvaluatedKey;
            } while (ExclusiveStartKey && out.length < limit);
            return out;
        }
        catch (err) {
            this.logger?.warn?.('conversations index channel lookup failed', { channel, error: err?.message });
            return [];
        }
    }
    /** All conversations for a user, newest activity first. */
    async listForUser(userId, limit = 50) {
        const res = await this.client.send(new client_dynamodb_1.QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'userId = :u',
            ExpressionAttributeValues: { ':u': { S: userId } },
            Limit: Math.min(Math.max(limit, 1), 200),
        }));
        const rows = (res?.Items ?? [])
            .map((item) => conversationRowFromItem(item, userId))
            .filter((r) => r.channel);
        rows.sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1));
        return rows;
    }
}
exports.DynamoConversationsStore = DynamoConversationsStore;
function conversationRowFromItem(item, userId, channel) {
    let peers = [];
    try {
        peers = JSON.parse(item.peers?.S ?? '[]');
    }
    catch { /* corrupt row — empty peers */ }
    return {
        userId,
        channel: item.channel?.S ?? channel ?? '',
        peers,
        lastMessageAt: item.lastMessageAt?.S ?? '',
        lastMessagePreview: item.lastMessagePreview?.S ?? '',
        lastMessageUserId: item.lastMessageUserId?.S ?? null,
        pinned: item.pinned?.BOOL === true,
        mutedUntil: item.mutedUntil?.S ?? null,
        unreadFrom: item.unreadFrom?.S ?? null,
        section: item.section?.S ?? null,
    };
}
//# sourceMappingURL=DynamoConversationsStore.js.map