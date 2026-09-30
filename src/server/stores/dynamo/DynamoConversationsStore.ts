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

import { BatchGetItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { ChatMessage } from '../../../chat/types';
import { dmChannelMembers, isDmChatChannel } from '../../../chat/dmChannels';
import {
    CHAT_TTL_SECONDS,
    requireClient,
    requireTable,
    ttlFrom,
    type DynamoCommandClient,
    type DynamoStoreClockOpts,
    type DynamoStoreLogger,
} from './common';

/** First this many characters of a message become the row's preview. */
export const CONVERSATION_PREVIEW_MAX = 140;

/** GSI on `chat-conversations` keyed by `channel`. */
export const CONVERSATIONS_CHANNEL_INDEX = 'channel-index';

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
export function changedMessageIndexMembers(
    channel: string,
    sender: string | undefined,
    channelRecipients: readonly string[],
): string[] {
    if (isDmChatChannel(channel)) return dmChannelMembers(channel) ?? [];
    return Array.from(new Set([...(sender ? [sender] : []), ...channelRecipients]));
}

export class DynamoConversationsStore {
    private readonly client: DynamoCommandClient;
    readonly tableName: string;
    readonly channelIndexName: string;
    private readonly logger?: DynamoStoreLogger;
    private readonly now: () => number;
    private readonly ttlSeconds: number;

    constructor(opts: DynamoConversationsStoreOpts) {
        this.client = requireClient('DynamoConversationsStore', opts?.client);
        this.tableName = requireTable('DynamoConversationsStore', opts.tableName);
        this.channelIndexName = opts.channelIndexName ?? CONVERSATIONS_CHANNEL_INDEX;
        this.logger = opts.logger;
        this.now = opts.now ?? Date.now;
        this.ttlSeconds = opts.ttlSeconds ?? CHAT_TTL_SECONDS;
    }

    /**
     * Upsert the row for EVERY member of the thread with the message's
     * preview and recency. Failures are logged and swallowed per member.
     */
    async recordMessage(info: { channel: string; members: string[]; message: ChatMessage }): Promise<void> {
        const { channel, members, message } = info;
        if (!members.length) return; // hashed group channels carry no parseable members
        const senderUserId = message.userId ?? null;
        const preview = (message.message ?? '').slice(0, CONVERSATION_PREVIEW_MAX);
        const ttl = ttlFrom(this.now, this.ttlSeconds);
        const peersJson = JSON.stringify(members);
        await Promise.all(members.map(async (userId) => {
            try {
                // UpdateItem, not Put: the row also carries this person's own
                // pinned / mutedUntil / unreadFrom / section.
                await this.client.send(new UpdateItemCommand({
                    TableName: this.tableName,
                    Key: { userId: { S: userId }, channel: { S: channel } },
                    UpdateExpression:
                        'SET peers = :peers, lastMessageAt = :at, lastMessagePreview = :preview, #ttl = :ttl'
                        + (senderUserId ? ', lastMessageUserId = :sender' : ''),
                    ExpressionAttributeNames: { '#ttl': 'ttl' },
                    ExpressionAttributeValues: {
                        ':peers': { S: peersJson },
                        ':at': { S: message.timestamp },
                        ':preview': { S: preview },
                        ':ttl': { N: ttl },
                        ...(senderUserId ? { ':sender': { S: senderUserId } } : {}),
                    },
                }));
            } catch (err) {
                this.logger?.warn?.('conversations index write failed', {
                    channel,
                    userId,
                    error: (err as Error)?.message,
                });
            }
        }));
    }

    /**
     * A message the server posted (`ChatService.postSystemMessage` — a
     * document card, a call card) is conversation traffic too, but no chat
     * hook sees it. Call this with what postSystemMessage resolved. DMs only,
     * members from the channel's name; channels are indexed from their sends.
     */
    async recordSystemMessage(channel: string, posted: ChatMessage | null | undefined): Promise<void> {
        if (!posted?.id) return;
        const members = changedMessageIndexMembers(channel, undefined, []);
        if (!members.length) return;
        await this.recordMessage({ channel, members, message: posted });
    }

    /**
     * A user joined a channel: make sure their row exists so the channel's
     * audience includes them. Idempotent; never touches preview or recency.
     */
    async recordJoin(channel: string, userId: string): Promise<void> {
        if (!channel || !userId) return;
        const now = new Date(this.now()).toISOString();
        try {
            await this.client.send(new UpdateItemCommand({
                TableName: this.tableName,
                Key: { userId: { S: userId }, channel: { S: channel } },
                UpdateExpression: 'SET peers = if_not_exists(peers, :peers), joinedAt = if_not_exists(joinedAt, :now), #ttl = :ttl',
                ExpressionAttributeNames: { '#ttl': 'ttl' },
                ExpressionAttributeValues: {
                    ':peers': { S: JSON.stringify([userId]) },
                    ':now': { S: now },
                    ':ttl': { N: ttlFrom(this.now, this.ttlSeconds) },
                },
            }));
        } catch (err) {
            this.logger?.warn?.('conversations index join write failed', { channel, userId, error: (err as Error)?.message });
        }
    }

    setPinned(userId: string, channel: string, pinned: boolean): Promise<ConversationRow> {
        return this.patchState(userId, channel, { pinned });
    }

    /** Mute until `mutedUntil` (ISO), or `null` to unmute. */
    setMuted(userId: string, channel: string, mutedUntil: string | null): Promise<ConversationRow> {
        return this.patchState(userId, channel, { mutedUntil });
    }

    /** Mark unread from a message's time, or `null` to clear it. */
    setUnreadFrom(userId: string, channel: string, unreadFrom: string | null): Promise<ConversationRow> {
        return this.patchState(userId, channel, { unreadFrom });
    }

    /** File the thread under this label, or `null` for the default grouping. */
    setSection(userId: string, channel: string, section: string | null): Promise<ConversationRow> {
        return this.patchState(userId, channel, { section });
    }

    /**
     * Any of the four per-person fields in one round trip. `null` REMOVEs the
     * attribute; `peers` and the ttl are seeded the way recordJoin seeds them
     * so a row created by pinning alone is well formed. Creates the row.
     */
    async patchState(userId: string, channel: string, patch: ConversationStatePatch): Promise<ConversationRow> {
        const sets: string[] = ['peers = if_not_exists(peers, :peers)', '#ttl = :ttl'];
        const removes: string[] = [];
        const names: Record<string, string> = { '#ttl': 'ttl' };
        const values: Record<string, unknown> = {
            ':peers': { S: JSON.stringify([userId]) },
            ':ttl': { N: ttlFrom(this.now, this.ttlSeconds) },
        };
        if (patch.pinned !== undefined) {
            sets.push('pinned = :pinned');
            values[':pinned'] = { BOOL: patch.pinned };
        }
        if (patch.mutedUntil !== undefined) {
            if (patch.mutedUntil === null) removes.push('mutedUntil');
            else { sets.push('mutedUntil = :mutedUntil'); values[':mutedUntil'] = { S: patch.mutedUntil }; }
        }
        if (patch.unreadFrom !== undefined) {
            if (patch.unreadFrom === null) removes.push('unreadFrom');
            else { sets.push('unreadFrom = :unreadFrom'); values[':unreadFrom'] = { S: patch.unreadFrom }; }
        }
        if (patch.section !== undefined) {
            // SECTION is a DynamoDB reserved word — always aliased.
            names['#section'] = 'section';
            if (patch.section === null) removes.push('#section');
            else { sets.push('#section = :section'); values[':section'] = { S: patch.section }; }
        }
        const res = await this.client.send(new UpdateItemCommand({
            TableName: this.tableName,
            Key: { userId: { S: userId }, channel: { S: channel } },
            UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values as never,
            ReturnValues: 'ALL_NEW',
        }));
        return conversationRowFromItem(res?.Attributes ?? {}, userId, channel);
    }

    /**
     * Which of `userIds` have muted this channel right now. One BatchGetItem
     * per 100 keys, projecting only the instant. Any failure answers
     * "nobody is muted" — a stray notification beats a lost one.
     */
    async mutedMembers(channel: string, userIds: readonly string[], now = new Date(this.now())): Promise<Set<string>> {
        const muted = new Set<string>();
        const unique = [...new Set(userIds.filter(Boolean))];
        if (!channel || unique.length === 0) return muted;
        try {
            for (let i = 0; i < unique.length; i += 100) {
                const chunk = unique.slice(i, i + 100);
                const res = await this.client.send(new BatchGetItemCommand({
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
                    if (!who || !until) continue;
                    const at = Date.parse(until);
                    if (Number.isFinite(at) && at > now.getTime()) muted.add(who);
                }
            }
        } catch (err) {
            this.logger?.warn?.('conversations mute lookup failed', { channel, error: (err as Error)?.message });
            return new Set<string>();
        }
        return muted;
    }

    /**
     * Everyone with a row for the channel (joined it, or was sent a message
     * in it), from the `channel-index` GSI. A table without the index answers
     * [] and logs — suitable as ChatService's `channelAudience`.
     */
    async listUsersForChannel(channel: string, limit = 500): Promise<string[]> {
        try {
            const out: string[] = [];
            let ExclusiveStartKey: Record<string, unknown> | undefined;
            do {
                const res = await this.client.send(new QueryCommand({
                    TableName: this.tableName,
                    IndexName: this.channelIndexName,
                    KeyConditionExpression: 'channel = :c',
                    ExpressionAttributeValues: { ':c': { S: channel } },
                    ProjectionExpression: 'userId',
                    Limit: Math.min(limit, 500),
                    ...(ExclusiveStartKey ? { ExclusiveStartKey: ExclusiveStartKey as never } : {}),
                }));
                for (const item of res?.Items ?? []) if (item.userId?.S) out.push(item.userId.S);
                ExclusiveStartKey = res?.LastEvaluatedKey as Record<string, unknown> | undefined;
            } while (ExclusiveStartKey && out.length < limit);
            return out;
        } catch (err) {
            this.logger?.warn?.('conversations index channel lookup failed', { channel, error: (err as Error)?.message });
            return [];
        }
    }

    /** All conversations for a user, newest activity first. */
    async listForUser(userId: string, limit = 50): Promise<ConversationRow[]> {
        const res = await this.client.send(new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'userId = :u',
            ExpressionAttributeValues: { ':u': { S: userId } },
            Limit: Math.min(Math.max(limit, 1), 200),
        }));
        const rows: ConversationRow[] = ((res?.Items ?? []) as Record<string, any>[])
            .map((item) => conversationRowFromItem(item, userId))
            .filter((r) => r.channel);
        rows.sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1));
        return rows;
    }
}

export function conversationRowFromItem(item: Record<string, any>, userId: string, channel?: string): ConversationRow {
    let peers: string[] = [];
    try { peers = JSON.parse(item.peers?.S ?? '[]'); } catch { /* corrupt row — empty peers */ }
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
