// DynamoChatStore and its tables against a DynamoDB double: the commands
// each call sends (keys, attributes, TTL, expressions), the round trips the
// ChatStore contract needs, and the conversations index maintenance that
// chatOptions() wires onto a real ChatService — including the DM edit rule
// (a DM re-indexes BOTH members with the pair as peers, never just the
// sender) and a server card patched in place (`updateSystemMessage`).

import { describe, it, expect, jest } from '@jest/globals';
import { ChatService } from '../../../src/chat/ChatService';
import { dmChatChannelFor } from '../../../src/chat/dmChannels';
import {
    DynamoChatStore,
    DynamoConversationsStore,
    changedMessageIndexMembers,
    CHAT_TTL_SECONDS,
} from '../../../src/server/stores/dynamo';
import { makeDdbDouble, flush } from './ddbDouble';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const TTL = String(Math.floor(NOW / 1000) + CHAT_TTL_SECONDS);

const msg = (over: Record<string, unknown> = {}) => ({
    id: 'm1',
    clientId: 'c1',
    channel: 'general',
    message: 'hello',
    timestamp: '2026-09-29T11:59:00.000Z',
    ...over,
}) as any;

function makeStore(extra: Record<string, unknown> = {}) {
    const ddb = makeDdbDouble();
    const store = new DynamoChatStore({ client: ddb, now: () => NOW, logger: { warn: jest.fn() }, ...extra } as any);
    return { ddb, store };
}

describe('DynamoChatStore construction', () => {
    it('requires a client with send', () => {
        expect(() => new DynamoChatStore({} as any)).toThrow(/client is required/);
        expect(() => new DynamoChatStore({ client: {} } as any)).toThrow(/client is required/);
    });

    it("defaults to realtime-examples' table names and applies the prefix to given and defaulted names", () => {
        expect(makeStore().store.tables).toEqual({
            messages: 'chat-messages', conversations: 'chat-conversations', members: 'chat-members', reads: 'chat-reads',
        });
        const { store } = makeStore({ tablePrefix: 'dev-', tables: { messages: 'msgs', reads: undefined } });
        expect(store.tables).toEqual({
            messages: 'dev-msgs', conversations: 'dev-chat-conversations', members: 'dev-chat-members', reads: 'dev-chat-reads',
        });
        expect(store.messages.tableName).toBe('dev-msgs');
        expect(store.conversations.tableName).toBe('dev-chat-conversations');
        expect(store.conversations.channelIndexName).toBe('channel-index');
    });
});

describe('putMessage', () => {
    it('writes the chat-messages row: channelId/messageId keys, ISO timestamp, 90-day ttl', async () => {
        const { ddb, store } = makeStore();
        await store.putMessage(msg());
        expect(ddb.sent).toEqual([{
            name: 'PutItemCommand',
            input: {
                TableName: 'chat-messages',
                Item: {
                    channelId: { S: 'general' },
                    messageId: { S: 'm1' },
                    clientId: { S: 'c1' },
                    message: { S: 'hello' },
                    timestamp: { S: '2026-09-29T11:59:00.000Z' },
                    ttl: { N: TTL },
                },
            },
        }]);
    });

    it('stores metadata as a JSON string only when non-empty, plus userId / editedAt / deletedAt when set', async () => {
        const { ddb, store } = makeStore();
        await store.putMessage(msg({ metadata: {} }));
        expect(ddb.sent[0].input.Item.metadata).toBeUndefined();
        await store.putMessage(msg({
            metadata: { kind: 'document', n: 1 }, userId: 'dev-hank', editedAt: '2026-09-29T12:01:00Z', deletedAt: '2026-09-29T12:02:00Z',
        }));
        const item = ddb.sent[1].input.Item;
        expect(item.metadata).toEqual({ S: '{"kind":"document","n":1}' });
        expect(item.userId).toEqual({ S: 'dev-hank' });
        expect(item.editedAt).toEqual({ S: '2026-09-29T12:01:00Z' });
        expect(item.deletedAt).toEqual({ S: '2026-09-29T12:02:00Z' });
    });

    it('honours ttlSeconds', async () => {
        const { ddb, store } = makeStore({ ttlSeconds: 60 });
        await store.putMessage(msg());
        expect(ddb.sent[0].input.Item.ttl).toEqual({ N: String(Math.floor(NOW / 1000) + 60) });
    });
});

describe('listMessages', () => {
    it('queries newest-first with the limit and returns chronological messages', async () => {
        const { ddb, store } = makeStore();
        ddb.respondNext('QueryCommand', {
            Items: [
                { channelId: { S: 'general' }, messageId: { S: 'm2' }, clientId: { S: 'c2' }, message: { S: 'second' }, timestamp: { S: 't2' }, userId: { S: 'dev-eve' }, editedAt: { S: 'e2' } },
                { channelId: { S: 'general' }, messageId: { S: 'm1' }, clientId: { S: 'c1' }, message: { S: 'first' }, timestamp: { S: 't1' }, metadata: { S: '{"a":1}' } },
            ],
        });
        const out = await store.listMessages('general', 25);
        expect(ddb.sent[0]).toEqual({
            name: 'QueryCommand',
            input: {
                TableName: 'chat-messages',
                KeyConditionExpression: 'channelId = :ch',
                ExpressionAttributeValues: { ':ch': { S: 'general' } },
                ScanIndexForward: false,
                Limit: 25,
            },
        });
        expect(out).toEqual([
            { id: 'm1', clientId: 'c1', channel: 'general', message: 'first', metadata: { a: 1 }, timestamp: 't1' },
            { id: 'm2', clientId: 'c2', userId: 'dev-eve', channel: 'general', message: 'second', metadata: {}, timestamp: 't2', editedAt: 'e2' },
        ]);
    });

    it('an unknown channel is []', async () => {
        expect(await makeStore().store.listMessages('nobody', 10)).toEqual([]);
    });
});

describe('updateMessage', () => {
    it('SETs only the patched fields, conditional on the row existing, and returns the whole record', async () => {
        const { ddb, store } = makeStore();
        await store.putMessage(msg({ userId: 'dev-hank', metadata: { a: 1 } }));
        ddb.clear();
        const out = await store.updateMessage('general', 'm1', { message: 'edited', editedAt: 'e1' });
        expect(ddb.sent[0]).toEqual({
            name: 'UpdateItemCommand',
            input: {
                TableName: 'chat-messages',
                Key: { channelId: { S: 'general' }, messageId: { S: 'm1' } },
                UpdateExpression: 'SET #message = :message, #editedAt = :editedAt',
                ExpressionAttributeNames: { '#message': 'message', '#editedAt': 'editedAt' },
                ExpressionAttributeValues: { ':message': { S: 'edited' }, ':editedAt': { S: 'e1' } },
                ConditionExpression: 'attribute_exists(messageId)',
                ReturnValues: 'ALL_NEW',
            },
        });
        expect(out).toEqual({
            id: 'm1', clientId: 'c1', userId: 'dev-hank', channel: 'general', message: 'edited',
            metadata: { a: 1 }, timestamp: '2026-09-29T11:59:00.000Z', editedAt: 'e1',
        });
    });

    it('a soft delete replaces metadata wholesale and keeps the row', async () => {
        const { ddb, store } = makeStore();
        await store.putMessage(msg({ metadata: { a: 1 } }));
        const out = await store.updateMessage('general', 'm1', { message: '', metadata: { deleted: true }, deletedAt: 'd1' });
        expect(out).toMatchObject({ message: '', metadata: { deleted: true }, deletedAt: 'd1' });
        expect(ddb.row('chat-messages', 'general', 'm1')!.metadata).toEqual({ S: '{"deleted":true}' });
    });

    it('resolves null for an unknown message and for an empty patch (no write)', async () => {
        const { ddb, store } = makeStore();
        expect(await store.updateMessage('general', 'missing', { message: 'x' })).toBeNull();
        ddb.clear();
        expect(await store.updateMessage('general', 'm1', {})).toBeNull();
        expect(ddb.sent).toEqual([]);
    });

    it('rethrows anything but a failed condition', async () => {
        const { ddb, store } = makeStore();
        ddb.failNext('UpdateItemCommand', Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }));
        await expect(store.updateMessage('general', 'm1', { message: 'x' })).rejects.toThrow('throttled');
    });
});

describe('conversations index', () => {
    it('recordMessage UPDATEs each member row (never a Put), with preview, recency, sender and ttl', async () => {
        const { ddb, store } = makeStore();
        await store.conversations.recordMessage({
            channel: 'room:design', members: ['dev-eve', 'dev-carol'], message: msg({ channel: 'room:design', userId: 'dev-carol', message: 'x'.repeat(200) }),
        });
        expect(ddb.sent.map((s) => s.name)).toEqual(['UpdateItemCommand', 'UpdateItemCommand']);
        expect(ddb.sent[0].input).toEqual({
            TableName: 'chat-conversations',
            Key: { userId: { S: 'dev-eve' }, channel: { S: 'room:design' } },
            UpdateExpression: 'SET peers = :peers, lastMessageAt = :at, lastMessagePreview = :preview, #ttl = :ttl, lastMessageUserId = :sender',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: {
                ':peers': { S: '["dev-eve","dev-carol"]' },
                ':at': { S: '2026-09-29T11:59:00.000Z' },
                ':preview': { S: 'x'.repeat(140) },
                ':ttl': { N: TTL },
                ':sender': { S: 'dev-carol' },
            },
        });
    });

    it('a pin survives the next message', async () => {
        const { ddb, store } = makeStore();
        await store.conversations.setPinned('dev-eve', 'room:design', true);
        await store.conversations.recordMessage({ channel: 'room:design', members: ['dev-eve'], message: msg({ channel: 'room:design' }) });
        const [row] = await store.conversations.listForUser('dev-eve');
        expect(row).toMatchObject({ channel: 'room:design', pinned: true, lastMessagePreview: 'hello', lastMessageUserId: null });
        expect(ddb.row('chat-conversations', 'dev-eve', 'room:design')!.lastMessageUserId).toBeUndefined();
    });

    it('no members is no write; a failed member write is logged and swallowed', async () => {
        const { ddb, store } = makeStore();
        await store.conversations.recordMessage({ channel: 'chat:dmg:abc', members: [], message: msg() });
        expect(ddb.sent).toEqual([]);
        ddb.failNext('UpdateItemCommand', new Error('boom'));
        await expect(store.conversations.recordMessage({ channel: 'g', members: ['a', 'b'], message: msg() })).resolves.toBeUndefined();
    });

    it("messageIndexWrites 'transaction' writes the SAME member updates in one TransactWriteItems request (0.110)", async () => {
        const each = makeStore();
        const tx = makeStore({ messageIndexWrites: 'transaction' });
        const info = { channel: 'room:design', members: ['dev-eve', 'dev-carol', 'dev-eve'], message: msg({ channel: 'room:design', userId: 'dev-carol' }) };
        await each.store.conversations.recordMessage(info);
        await tx.store.conversations.recordMessage(info);
        expect(tx.ddb.sent.map((s) => s.name)).toEqual(['TransactWriteItemsCommand']);
        // Duplicates collapse (a transaction may not name one item twice);
        // each Update is exactly the per-member UpdateItem input.
        const updates = tx.ddb.sent[0].input.TransactItems.map((i: any) => i.Update);
        expect(updates).toEqual(each.ddb.sent.slice(0, 2).map((s) => s.input));
        expect(tx.ddb.rows('chat-conversations')).toEqual(each.ddb.rows('chat-conversations'));
    });

    it("messageIndexWrites 'transaction' falls back to per-member writes when the transaction fails, and one member stays an UpdateItem", async () => {
        const warn = jest.fn();
        const { ddb, store } = makeStore({ messageIndexWrites: 'transaction', logger: { warn } });
        ddb.failNext('TransactWriteItemsCommand', Object.assign(new Error('conflict'), { name: 'TransactionCanceledException' }));
        await store.conversations.recordMessage({ channel: 'g', members: ['a', 'b'], message: msg({ channel: 'g' }) });
        expect(ddb.sent.map((s) => s.name)).toEqual(['TransactWriteItemsCommand', 'UpdateItemCommand', 'UpdateItemCommand']);
        expect(ddb.row('chat-conversations', 'a', 'g')).toBeDefined();
        expect(ddb.row('chat-conversations', 'b', 'g')).toBeDefined();
        expect(warn).toHaveBeenCalledWith('conversations index transaction failed; writing rows one by one', expect.objectContaining({ channel: 'g' }));
        ddb.clear();
        await store.conversations.recordMessage({ channel: 'solo', members: ['a'], message: msg({ channel: 'solo' }) });
        expect(ddb.sent.map((s) => s.name)).toEqual(['UpdateItemCommand']);
    });

    it("messageIndexWrites splits more than 100 members into transactions of at most 100 and rejects unknown modes", async () => {
        const { ddb, store } = makeStore({ messageIndexWrites: 'transaction' });
        const members = Array.from({ length: 201 }, (_, i) => `u${i}`);
        await store.conversations.recordMessage({ channel: 'big', members, message: msg({ channel: 'big' }) });
        expect(ddb.sent.map((s) => s.name).sort()).toEqual(['TransactWriteItemsCommand', 'TransactWriteItemsCommand', 'UpdateItemCommand']);
        expect(ddb.sent.filter((s) => s.name === 'TransactWriteItemsCommand').map((s) => s.input.TransactItems.length)).toEqual([100, 100]);
        expect(ddb.rows('chat-conversations')).toHaveLength(201);
        expect(() => new DynamoConversationsStore({ client: ddb, tableName: 't', messageIndexWrites: 'batch' } as any)).toThrow(/messageIndexWrites/);
    });

    it('recordJoin seeds peers/joinedAt only if absent and refreshes ttl', async () => {
        const { ddb, store } = makeStore();
        await store.conversations.recordJoin('room:design', 'dev-eve');
        expect(ddb.sent[0].input).toEqual({
            TableName: 'chat-conversations',
            Key: { userId: { S: 'dev-eve' }, channel: { S: 'room:design' } },
            UpdateExpression: 'SET peers = if_not_exists(peers, :peers), joinedAt = if_not_exists(joinedAt, :now), #ttl = :ttl',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: {
                ':peers': { S: '["dev-eve"]' },
                ':now': { S: '2026-09-29T12:00:00.000Z' },
                ':ttl': { N: TTL },
            },
        });
    });

    it('state patches alias the reserved word section and REMOVE on null', async () => {
        const { ddb, store } = makeStore();
        const row = await store.conversations.setSection('dev-eve', 'room:design', 'Work');
        expect(row.section).toBe('Work');
        await store.conversations.setSection('dev-eve', 'room:design', null);
        expect(ddb.sent[1].input.UpdateExpression).toBe('SET peers = if_not_exists(peers, :peers), #ttl = :ttl REMOVE #section');
        expect(ddb.sent[1].input.ExpressionAttributeNames).toEqual({ '#ttl': 'ttl', '#section': 'section' });
        const muted = await store.conversations.setMuted('dev-eve', 'room:design', '2099-01-01T00:00:00.000Z');
        expect(muted.mutedUntil).toBe('2099-01-01T00:00:00.000Z');
        expect((await store.conversations.setUnreadFrom('dev-eve', 'room:design', 't1')).unreadFrom).toBe('t1');
    });

    it('mutedMembers reads only the instant, in one batch, and answers nobody on failure', async () => {
        const { ddb, store } = makeStore();
        await store.conversations.setMuted('a', 'g', '2099-01-01T00:00:00.000Z');
        await store.conversations.setMuted('b', 'g', '2000-01-01T00:00:00.000Z');
        ddb.clear();
        expect([...await store.conversations.mutedMembers('g', ['a', 'b', 'c', 'a'])]).toEqual(['a']);
        expect(ddb.sent[0].input.RequestItems['chat-conversations'].ProjectionExpression).toBe('userId, mutedUntil');
        expect(ddb.sent[0].input.RequestItems['chat-conversations'].Keys).toHaveLength(3);
        ddb.failNext('BatchGetItemCommand', new Error('down'));
        expect([...await store.conversations.mutedMembers('g', ['a'])]).toEqual([]);
    });

    it('listUsersForChannel reads the channel-index GSI; a failure is []', async () => {
        const { ddb, store } = makeStore();
        await store.conversations.recordJoin('g', 'a');
        await store.conversations.recordJoin('g', 'b');
        ddb.clear();
        expect(await store.conversations.listUsersForChannel('g')).toEqual(['a', 'b']);
        expect(ddb.sent[0].input).toMatchObject({ IndexName: 'channel-index', KeyConditionExpression: 'channel = :c', ProjectionExpression: 'userId' });
        ddb.failNext('QueryCommand', new Error('no index'));
        expect(await store.conversations.listUsersForChannel('g')).toEqual([]);
    });

    it('listForUser sorts newest activity first', async () => {
        const { store } = makeStore();
        await store.conversations.recordMessage({ channel: 'old', members: ['u'], message: msg({ timestamp: '2026-01-01T00:00:00Z' }) });
        await store.conversations.recordMessage({ channel: 'new', members: ['u'], message: msg({ timestamp: '2026-09-01T00:00:00Z' }) });
        expect((await store.conversations.listForUser('u')).map((r) => r.channel)).toEqual(['new', 'old']);
    });

    it('changedMessageIndexMembers: a DM is its name, a hashed group DM is nobody, a channel is sender + recipients', () => {
        const dm = dmChatChannelFor(['dev-dave', 'dev-eve']);
        expect(changedMessageIndexMembers(dm, 'dev-dave', []).sort()).toEqual(['dev-dave', 'dev-eve']);
        expect(changedMessageIndexMembers('chat:dmg:abcdef', 'dev-dave', ['x'])).toEqual([]);
        expect(changedMessageIndexMembers('room:x', 's', ['a', 's', 'b'])).toEqual(['s', 'a', 'b']);
    });

    it('recordSystemMessage indexes a DM card for both members and ignores channels', async () => {
        const { ddb, store } = makeStore();
        const dm = dmChatChannelFor(['dev-dave', 'dev-eve']);
        await store.conversations.recordSystemMessage('room:x', msg({ channel: 'room:x' }));
        expect(ddb.sent).toEqual([]);
        await store.conversations.recordSystemMessage(dm, msg({ channel: dm, clientId: 'system', message: 'Dave created Plan' }));
        expect(ddb.rows('chat-conversations').map((r) => [r.userId.S, JSON.parse(r.peers.S).sort()])).toEqual([
            ['dev-dave', ['dev-dave', 'dev-eve']], ['dev-eve', ['dev-dave', 'dev-eve']],
        ]);
    });
});

describe('membership and read receipts', () => {
    it('chat-members round-trips a member, removedAt included', async () => {
        const { ddb, store } = makeStore();
        await store.members.putMember({ channel: 'g', userId: 'a', role: 'owner', addedBy: 'a', addedAt: 't', historyFrom: null, removedAt: 'r' });
        expect(ddb.sent[0].input).toEqual({
            TableName: 'chat-members',
            Item: { channel: { S: 'g' }, userId: { S: 'a' }, role: { S: 'owner' }, addedBy: { S: 'a' }, addedAt: { S: 't' }, removedAt: { S: 'r' } },
        });
        expect(await store.members.getMember('g', 'a')).toEqual({ channel: 'g', userId: 'a', role: 'owner', addedBy: 'a', addedAt: 't', historyFrom: null, removedAt: 'r' });
        expect(await store.members.getMember('g', 'nobody')).toBeNull();
        expect(await store.members.listMembers('g')).toHaveLength(1);
    });

    it('chat-reads advances conditionally with a ttl; a refused advance is null', async () => {
        const { ddb, store } = makeStore();
        const r = { channel: 'g', userId: 'a', readAt: 't2', updatedAt: 'u', displayName: 'Ada' };
        expect(await store.reads.advance(r)).toEqual(r);
        expect(ddb.sent[0].input).toEqual({
            TableName: 'chat-reads',
            Item: { channel: { S: 'g' }, userId: { S: 'a' }, readAt: { S: 't2' }, updatedAt: { S: 'u' }, ttl: { N: TTL }, displayName: { S: 'Ada' } },
            ConditionExpression: 'attribute_not_exists(readAt) OR readAt < :readAt',
            ExpressionAttributeValues: { ':readAt': { S: 't2' } },
        });
        ddb.failNext('PutItemCommand', Object.assign(new Error('no'), { name: 'ConditionalCheckFailedException' }));
        expect(await store.reads.advance({ ...r, readAt: 't1' })).toBeNull();
        expect(await store.reads.listReceipts('g')).toEqual([r]);
        await store.reads.deleteReceipt('g', 'a');
        expect(await store.reads.listReceipts('g')).toEqual([]);
    });
});

// ---- chatOptions() on a real ChatService ----------------------------------

function makeRouter() {
    return {
        redisAvailable: false,
        sendToClient: jest.fn(),
        sendToChannel: jest.fn(async () => undefined),
        subscribeToChannel: jest.fn(async () => true),
        unsubscribeFromChannel: jest.fn(async () => undefined),
    } as any;
}

function serviceWith(store: DynamoChatStore, extra: Parameters<DynamoChatStore['chatOptions']>[0] = {}) {
    return new ChatService({
        messageRouter: makeRouter(),
        logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
        identityResolver: (clientId: string) => ({ userId: clientId }),
        ...store.chatOptions(extra),
    } as any);
}

const peersOf = (ddb: ReturnType<typeof makeDdbDouble>, userId: string, channel: string) => {
    const row = ddb.row('chat-conversations', userId, channel);
    return row ? JSON.parse(row.peers.S).sort() : undefined;
};

describe('chatOptions() maintains the conversations index from ChatService', () => {
    const dm = dmChatChannelFor(['dev-dave', 'dev-eve']);

    it('wires the three stores and the five hooks', () => {
        const { store } = makeStore();
        const o = store.chatOptions();
        expect(o.chatStore).toBe(store);
        expect(o.membershipStore).toBe(store.members);
        expect(o.readReceiptStore).toBe(store.reads);
        for (const k of ['onDmMessage', 'onChannelMessage', 'onMessageChanged', 'onChannelJoin', 'channelAudience'] as const) {
            expect(typeof o[k]).toBe('function');
        }
    });

    it('a DM send persists the message and indexes both members with the pair as peers', async () => {
        const { ddb, store } = makeStore();
        const onDmMessage = jest.fn();
        const svc = serviceWith(store, { onDmMessage });
        await svc.handleAction('dev-dave', 'join', { channel: dm });
        await svc.handleAction('dev-dave', 'send', { channel: dm, message: 'hi eve' });
        await flush();
        expect(ddb.rows('chat-messages')).toHaveLength(1);
        expect(peersOf(ddb, 'dev-dave', dm)).toEqual(['dev-dave', 'dev-eve']);
        expect(peersOf(ddb, 'dev-eve', dm)).toEqual(['dev-dave', 'dev-eve']);
        expect(ddb.row('chat-conversations', 'dev-eve', dm)!.lastMessagePreview).toEqual({ S: 'hi eve' });
        expect(onDmMessage).toHaveBeenCalledTimes(1);
    });

    it('a DM edit re-indexes BOTH members (peers stay the pair); a delete previews "Message deleted"', async () => {
        const { ddb, store } = makeStore();
        const svc = serviceWith(store);
        await svc.handleAction('dev-dave', 'join', { channel: dm });
        await svc.handleAction('dev-dave', 'send', { channel: dm, message: 'hi eve' });
        const [sent] = await svc.getChannelHistory(dm, 10);
        await flush();
        ddb.clear();
        await svc.handleAction('dev-dave', 'edit', { channel: dm, messageId: sent.id, message: 'hi eve!' });
        await flush();
        const indexWrites = ddb.sent.filter((s) => s.input.TableName === 'chat-conversations');
        expect(indexWrites.map((s) => s.input.Key.userId.S).sort()).toEqual(['dev-dave', 'dev-eve']);
        expect(peersOf(ddb, 'dev-dave', dm)).toEqual(['dev-dave', 'dev-eve']);
        expect(ddb.row('chat-conversations', 'dev-eve', dm)!.lastMessagePreview).toEqual({ S: 'hi eve!' });
        await svc.handleAction('dev-dave', 'delete', { channel: dm, messageId: sent.id });
        await flush();
        expect(ddb.row('chat-conversations', 'dev-eve', dm)!.lastMessagePreview).toEqual({ S: 'Message deleted' });
        expect(ddb.row('chat-messages', dm, sent.id)!.message).toEqual({ S: '' });
    });

    it('a server card patched in place (updateSystemMessage → messageUpdated) moves the DM row for both members', async () => {
        const { ddb, store } = makeStore();
        const svc = serviceWith(store);
        const posted = await svc.postSystemMessage(dm, 'Call started', { kind: 'call', live: true });
        await store.conversations.recordSystemMessage(dm, posted);
        await flush();
        expect(peersOf(ddb, 'dev-eve', dm)).toEqual(['dev-dave', 'dev-eve']);
        const updated = await svc.updateSystemMessage(dm, posted!.id, { message: 'Call ended', metadata: { live: false } });
        await flush();
        expect(updated).toMatchObject({ message: 'Call ended', metadata: { kind: 'call', live: false, system: true } });
        expect(JSON.parse(ddb.row('chat-messages', dm, posted!.id)!.metadata.S)).toMatchObject({ live: false });
        for (const u of ['dev-dave', 'dev-eve']) {
            expect(peersOf(ddb, u, dm)).toEqual(['dev-dave', 'dev-eve']);
            expect(ddb.row('chat-conversations', u, dm)!.lastMessagePreview).toEqual({ S: 'Call ended' });
        }
    });

    it('a channel send indexes the sender and the audience; a channel edit uses the service recipient rule', async () => {
        const { ddb, store } = makeStore();
        const svc = serviceWith(store);
        await svc.handleAction('dev-carol', 'join', { channel: 'room:design' });
        await svc.handleAction('dev-eve', 'join', { channel: 'room:design' });
        await flush();
        // onChannelJoin seeded both rows (the audience).
        expect(ddb.row('chat-conversations', 'dev-eve', 'room:design')!.joinedAt).toBeDefined();
        await svc.handleAction('dev-carol', 'send', { channel: 'room:design', message: 'standup?' });
        await flush();
        for (const u of ['dev-carol', 'dev-eve']) {
            expect(ddb.row('chat-conversations', u, 'room:design')!.lastMessagePreview).toEqual({ S: 'standup?' });
        }
        const [m] = await svc.getChannelHistory('room:design', 10);
        ddb.clear();
        await svc.handleAction('dev-carol', 'edit', { channel: 'room:design', messageId: m.id, message: 'standup at 10?' });
        await flush();
        const keys = ddb.sent.filter((s) => s.name === 'UpdateItemCommand' && s.input.TableName === 'chat-conversations').map((s) => s.input.Key.userId.S).sort();
        expect(keys).toEqual(['dev-carol', 'dev-eve']);
    });

    it('channelRecipients overrides the recipient rule for a channel edit', async () => {
        const { ddb, store } = makeStore();
        const channelRecipients = jest.fn(async (_c: string, _s: string | undefined) => ['dev-zed']);
        const svc = serviceWith(store, { channelRecipients });
        await svc.handleAction('dev-carol', 'join', { channel: 'room:x' });
        await svc.handleAction('dev-carol', 'send', { channel: 'room:x', message: 'a' });
        const [m] = await svc.getChannelHistory('room:x', 10);
        await flush();
        ddb.clear();
        await svc.handleAction('dev-carol', 'edit', { channel: 'room:x', messageId: m.id, message: 'b' });
        await flush();
        expect(channelRecipients).toHaveBeenCalledWith('room:x', 'dev-carol');
        const keys = ddb.sent.filter((s) => s.input.TableName === 'chat-conversations').map((s) => s.input.Key.userId.S).sort();
        expect(keys).toEqual(['dev-carol', 'dev-zed']);
    });

    it('history survives a restart: a new service reads chat-messages back', async () => {
        const { ddb, store } = makeStore();
        const a = serviceWith(store);
        await a.handleAction('dev-carol', 'join', { channel: 'general' });
        await a.handleAction('dev-carol', 'send', { channel: 'general', message: 'persisted' });
        await flush();
        const b = serviceWith(new DynamoChatStore({ client: ddb, now: () => NOW }));
        const history = await b.getChannelHistory('general', 10);
        expect(history.map((h) => h.message)).toEqual(['persisted']);
        expect(history[0].userId).toBe('dev-carol');
    });

    it('DynamoConversationsStore can be used alone', () => {
        const ddb = makeDdbDouble();
        expect(new DynamoConversationsStore({ client: ddb, tableName: 't', channelIndexName: 'by-channel' }).channelIndexName).toBe('by-channel');
    });
});
