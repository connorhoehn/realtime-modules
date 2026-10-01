import { InMemoryChatStore } from '../../../src/chat/ChatStore';
import type { ChatMessage } from '../../../src/chat/types';
import { DynamoChatStore } from '../../../src/server/stores/dynamo';
import { makeDdbDouble } from './ddbDouble';

const NOW = Date.parse('2026-10-01T18:00:00.000Z');
const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
    id: 'old', channel: 'social:ch:general', clientId: 'connection', userId: 'alice',
    message: 'Original text', metadata: { displayName: 'Alice' }, timestamp: new Date(NOW - 1_000).toISOString(), ...over,
});

describe.each(['memory', 'dynamo'])('%s direct message lookup', (kind) => {
    it('finds old messages independently of the history cap, isolates channels and clones results', async () => {
        const store = kind === 'memory' ? new InMemoryChatStore()
            : new DynamoChatStore({ client: makeDdbDouble(), now: () => NOW });
        await store.putMessage(message());
        await store.putMessage(message({ id: 'new', timestamp: new Date(NOW).toISOString() }));
        expect((await store.listMessages(message().channel, 1))[0].id).toBe('new');
        const found = await store.getMessage(message().channel, 'old');
        expect(found).toEqual(message());
        found!.message = 'Mutated'; found!.metadata!.displayName = 'Impostor';
        expect(await store.getMessage(message().channel, 'old')).toEqual(message());
        expect(await store.getMessage('social:ch:private', 'old')).toBeNull();
        expect(await store.getMessage(message().channel, 'missing')).toBeNull();
    });
});

it('uses consistent keyed Dynamo reads, hides expired messages and propagates lookup failures', async () => {
    const client = makeDdbDouble();
    let now = NOW;
    const store = new DynamoChatStore({ client, now: () => now, ttlSeconds: 10 });
    await store.putMessage(message());
    await store.getMessage(message().channel, 'old');
    expect(client.sent.at(-1)).toEqual({ name: 'GetItemCommand', input: {
        TableName: 'chat-messages', Key: { channelId: { S: message().channel }, messageId: { S: 'old' } }, ConsistentRead: true,
    } });
    now += 10_000;
    expect(await store.getMessage(message().channel, 'old')).toBeNull();
    client.failNext('GetItemCommand', new Error('Database unavailable'));
    await expect(store.getMessage(message().channel, 'old')).rejects.toThrow('Database unavailable');
});
