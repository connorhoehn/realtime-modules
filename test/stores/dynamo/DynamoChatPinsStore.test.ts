import { MemoryChatPinsStore, type ChatPinInput, type ChatPinsStore } from '../../../src/chat/ChatPinsStore';
import { DynamoChatPinsStore, CHAT_TTL_SECONDS } from '../../../src/server/stores/dynamo';
import { makeDdbDouble } from './ddbDouble';

const NOW = Date.parse('2026-10-01T18:00:00.000Z');
const input = (over: Partial<ChatPinInput> = {}): ChatPinInput => ({
    channelId: 'social:ch:general', messageId: 'm1', pinnedBy: 'bob',
    text: 'hello\n  everyone', author: 'Alice', sentAt: '2026-10-01T17:00:00.000Z', ...over,
});

describe.each(['memory', 'dynamo'])('%s pins contract', (kind) => {
    let store: ChatPinsStore;
    beforeEach(() => {
        store = kind === 'memory' ? new MemoryChatPinsStore({ now: () => NOW })
            : new DynamoChatPinsStore({ client: makeDdbDouble({ keys: { 'chat-pins': ['channelId', 'messageId'] } }), tableName: 'chat-pins', now: () => NOW });
    });
    it('pins another author without changing the send time, and keeps the preview short', async () => {
        expect(await store.pin(input())).toEqual({ channelId: 'social:ch:general', messageId: 'm1', pinnedBy: 'bob',
            pinnedAt: new Date(NOW).toISOString(), preview: 'hello everyone', author: 'Alice', sentAt: input().sentAt });
        const long = await store.pin(input({ messageId: 'm2', text: 'x'.repeat(400), sentAt: undefined }));
        expect(long.preview).toHaveLength(140);
        expect(long.preview.endsWith('…')).toBe(true);
        expect(long).not.toHaveProperty('sentAt');
    });
    it('upserts one row per message and keeps other channels private', async () => {
        await store.pin(input());
        await store.pin(input({ pinnedBy: 'carol' }));
        await store.pin(input({ channelId: 'social:ch:private', pinnedBy: 'eve' }));
        expect(await store.list('social:ch:general')).toHaveLength(1);
        expect((await store.list('social:ch:general'))[0].pinnedBy).toBe('carol');
        await store.unpin('social:ch:general', 'm1');
        await store.unpin('social:ch:general', 'm1');
        expect(await store.list('social:ch:general')).toEqual([]);
        expect(await store.list('social:ch:private')).toHaveLength(1);
    });
});

it('a new Dynamo adapter reads durable pins and propagates write failures', async () => {
    const client = makeDdbDouble({ keys: { 'test-pins': ['channelId', 'messageId'] } });
    const opts = { client, tableName: 'test-pins', now: () => NOW };
    await new DynamoChatPinsStore(opts).pin(input());
    expect(client.rows('test-pins')[0].ttl.N).toBe(String(NOW / 1000 + CHAT_TTL_SECONDS));
    expect(await new DynamoChatPinsStore(opts).list(input().channelId)).toHaveLength(1);
    client.failNext('DeleteItemCommand', new Error('store unavailable'));
    await expect(new DynamoChatPinsStore(opts).unpin(input().channelId, 'm1')).rejects.toThrow('store unavailable');
});

it('reads all query pages before sorting by pin recency and filters expired rows', async () => {
    const client = makeDdbDouble();
    const row = (id: string, at: string, ttl = NOW / 1000 + 10) => ({
        messageId: { S: id }, pinnedAt: { S: at }, ttl: { N: String(ttl) },
    });
    const key = { channelId: { S: 'general' }, messageId: { S: 'a' } };
    client.respondNext('QueryCommand', { Items: [row('a', '2026-09-30T10:00:00Z')], LastEvaluatedKey: key });
    client.respondNext('QueryCommand', { Items: [row('b', '2026-10-01T10:00:00Z'), row('expired', '2026-10-01T11:00:00Z', NOW / 1000)] });
    const store = new DynamoChatPinsStore({ client, tableName: 'chat-pins', now: () => NOW });
    expect((await store.list('general')).map((p) => p.messageId)).toEqual(['b', 'a']);
    expect(client.sent[1].input.ExclusiveStartKey).toEqual(key);
    expect(client.sent[0].input.ConsistentRead).toBe(true);
});

it('memory fixture replacement removes pins without a stale cache', async () => {
    let rows: Awaited<ReturnType<ChatPinsStore['list']>> = [];
    const store = new MemoryChatPinsStore({ rows: () => rows, now: () => NOW });
    await store.pin(input()); rows = [];
    expect(await store.list(input().channelId)).toEqual([]);
});
