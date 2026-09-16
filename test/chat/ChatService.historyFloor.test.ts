import { describe, it, expect, jest } from '@jest/globals';
import { ChatService } from '../../src/chat/ChatService';
import { InMemoryChatStore } from '../../src/chat/ChatStore';
import { MemoryChatMembershipStore } from '../../src/chat/ChatMembershipStore';

class NoopLogger { info() {} warn() {} error() {} debug() {} }

function makeRouter() {
    const sentToClient: any[] = [];
    const router: any = {
        redisAvailable: false,
        sendToClient: jest.fn((clientId: string, message: any) => { sentToClient.push({ clientId, message }); }),
        sendToChannel: jest.fn(async () => undefined),
        subscribeToChannel: jest.fn(async () => true),
        unsubscribeFromChannel: jest.fn(async () => undefined),
        getClientData: jest.fn(() => ({})),
    };
    return { router, sentToClient };
}
const IDS: Record<string, { userId: string; displayName: string }> = {
    eve: { userId: 'u-eve', displayName: 'Eve' },
    carol: { userId: 'u-carol', displayName: 'Carol' },
    dave: { userId: 'u-dave', displayName: 'Dave' },
};
const day = 24 * 60 * 60 * 1000;
function msg(id: string, channel: string, daysAgo: number, userId = 'u-eve') {
    return { id, clientId: 'c', userId, channel, message: id, metadata: {}, timestamp: new Date(Date.now() - daysAgo * day).toISOString() };
}

describe('history after a restart', () => {
    it('merges the stored tail with what the cache has seen since', async () => {
        const chatStore = new InMemoryChatStore();
        for (let i = 12; i >= 1; i--) await chatStore.putMessage(msg(`old-${i}`, 'room:x', i));
        const { router } = makeRouter();
        const svc = new ChatService({ messageRouter: router, logger: new NoopLogger() as any, chatStore, identityResolver: (c: string) => IDS[c] ?? null } as any);
        await svc.handleAction('eve', 'join', { channel: 'room:x' });
        await svc.handleAction('eve', 'send', { channel: 'room:x', message: 'new-1' });
        const history = await svc.getChannelHistory('room:x', 50);
        expect(history.map((m) => m.message)).toEqual([...Array.from({ length: 12 }, (_, i) => `old-${12 - i}`), 'new-1']);
        // And the limit still trims from the oldest end.
        expect((await svc.getChannelHistory('room:x', 3)).map((m) => m.message)).toEqual(['old-2', 'old-1', 'new-1']);
    });
});

describe('history floors', () => {
    async function build() {
        const chatStore = new InMemoryChatStore();
        for (let i = 10; i >= 1; i--) await chatStore.putMessage(msg(`m-${i}`, 'room:x', i));
        const membership = new MemoryChatMembershipStore();
        const { router } = makeRouter();
        const svc = new ChatService({ messageRouter: router, logger: new NoopLogger() as any, chatStore, membershipStore: membership, identityResolver: (c: string) => IDS[c] ?? null } as any);
        return { svc, membership };
    }

    it('an owner with a null floor sees everything', async () => {
        const { svc, membership } = await build();
        await membership.putMember({ channel: 'room:x', userId: 'u-eve', role: 'owner', addedBy: 'u-eve', addedAt: 'x', historyFrom: null, removedAt: null });
        await membership.putMember({ channel: 'room:x', userId: 'u-carol', role: 'member', addedBy: 'u-eve', addedAt: 'x', historyFrom: new Date(Date.now() - 7 * day + 1000).toISOString(), removedAt: null });
        expect((await svc.getChannelHistoryFor('u-eve', 'room:x', 50)).length).toBe(10);
    });

    it('a floored member sees only from their floor', async () => {
        const { svc, membership } = await build();
        await membership.putMember({ channel: 'room:x', userId: 'u-eve', role: 'owner', addedBy: 'u-eve', addedAt: 'x', historyFrom: null, removedAt: null });
        await membership.putMember({ channel: 'room:x', userId: 'u-carol', role: 'member', addedBy: 'u-eve', addedAt: 'x', historyFrom: new Date(Date.now() - 3.5 * day).toISOString(), removedAt: null });
        const carol = await svc.getChannelHistoryFor('u-carol', 'room:x', 50);
        expect(carol.map((m) => m.message)).toEqual(['m-3', 'm-2', 'm-1']);
        expect((await svc.getChannelHistoryFor('u-dave', 'room:x', 50)).length).toBe(0);
    });

    it('an open channel is never floored, whoever joined when', async () => {
        const { svc } = await build();
        await svc.handleAction('dave', 'join', { channel: 'room:x' });
        expect((await svc.getChannelHistoryFor('u-dave', 'room:x', 50)).length).toBe(10);
        expect((await svc.getChannelHistoryFor(undefined, 'room:x', 50)).length).toBe(10);
    });
});
