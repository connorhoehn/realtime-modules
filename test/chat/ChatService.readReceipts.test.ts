// Read receipts: a per-member CURSOR, stored and broadcast, kept only where
// the roster is nameable and small, monotonic, and cleared when somebody
// leaves the channel (but not when they merely close a tab).
import { describe, it, expect, jest } from '@jest/globals';
import { ChatService } from '../../src/chat/ChatService';
import { InMemoryChatStore } from '../../src/chat/ChatStore';
import { MemoryChatMembershipStore } from '../../src/chat/ChatMembershipStore';
import { MemoryChatReadReceiptStore } from '../../src/chat/ChatReadReceiptStore';

class NoopLogger { info() {} warn() {} error() {} debug() {} }

function makeRouter() {
    const sentToClient: any[] = [];
    const sendToChannelCalls: any[] = [];
    const router: any = {
        redisAvailable: false,
        sendToClient: jest.fn((clientId: string, message: any) => { sentToClient.push({ clientId, message }); }),
        sendToChannel: jest.fn(async (channel: string, message: any, excludeClientId?: string | null, opts?: any) => {
            sendToChannelCalls.push({ channel, message, excludeClientId, opts });
        }),
        subscribeToChannel: jest.fn(async () => true),
        unsubscribeFromChannel: jest.fn(async () => undefined),
        getClientData: jest.fn(() => ({})),
    };
    return { router, sentToClient, sendToChannelCalls };
}

const IDS: Record<string, { userId: string; displayName: string }> = {
    eve: { userId: 'u-eve', displayName: 'Eve Thompson' },
    carol: { userId: 'u-carol', displayName: 'Carol Johnson' },
    bob: { userId: 'u-bob', displayName: 'Bob Martinez' },
    dave: { userId: 'u-dave', displayName: 'Dave Singh' },
};

interface Harness {
    svc: ChatService;
    members: MemoryChatMembershipStore;
    receipts: MemoryChatReadReceiptStore;
    chatStore: InMemoryChatStore;
    seen: any[];
}

function makeService(router: any, extra: Record<string, unknown> = {}): Harness {
    const members = new MemoryChatMembershipStore();
    const receipts = new MemoryChatReadReceiptStore();
    const chatStore = new InMemoryChatStore();
    const seen: any[] = [];
    const svc = new ChatService({
        messageRouter: router,
        logger: new NoopLogger() as any,
        chatStore,
        membershipStore: members,
        readReceiptStore: receipts,
        identityResolver: (clientId: string) => IDS[clientId] ?? null,
        onReadReceipt: (info: any) => seen.push(info),
        ...extra,
    } as any);
    return { svc, members, receipts, chatStore, seen };
}

const framesTo = (sent: any[], clientId: string, action: string) =>
    sent.filter((s) => s.clientId === clientId && s.message.action === action).map((s) => s.message);
const errorsTo = (sent: any[], clientId: string) =>
    sent.filter((s) => s.clientId === clientId && s.message.type === 'error').map((s) => s.message);
const broadcasts = (calls: any[], action: string) =>
    calls.filter((c) => c.message.action === action).map((c) => c.message);

/** A closed channel with `owner` plus everyone in `others`. */
async function closeChannel(svc: ChatService, owner: string, others: string[], channel = 'room:design'): Promise<void> {
    await svc.handleAction(owner, 'addMembers', {
        channel,
        userIds: others.map((c) => IDS[c].userId),
        history: { mode: 'all' },
    });
}

describe('ChatService read receipts — the happy path', () => {
    it('stores the cursor and tells the whole channel, the reader included', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc, receipts, seen } = makeService(router);
        await closeChannel(svc, 'carol', ['eve']);
        sendToChannelCalls.length = 0;

        await svc.handleAction('eve', 'read', { channel: 'room:design', at: '2026-09-16T09:00:00.000Z' });
        expect(errorsTo(sentToClient, 'eve')).toEqual([]);

        const out = broadcasts(sendToChannelCalls, 'readReceipt');
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            type: 'chat',
            action: 'readReceipt',
            channel: 'room:design',
            userId: 'u-eve',
            displayName: 'Eve Thompson',
            readAt: '2026-09-16T09:00:00.000Z',
        });
        // Not excluded: the reader's other tabs need the accepted value.
        const call = sendToChannelCalls.find((c) => c.message.action === 'readReceipt');
        expect(call.excludeClientId).toBeNull();
        expect(call.opts).toEqual({ publisherClientId: 'eve' });

        expect(await receipts.listReceipts('room:design')).toEqual([
            expect.objectContaining({ channel: 'room:design', userId: 'u-eve', readAt: '2026-09-16T09:00:00.000Z' }),
        ]);
        expect(seen[0]).toMatchObject({ channel: 'room:design', receipt: { userId: 'u-eve' } });
    });

    it('takes the cursor from a messageId when given one', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const { svc } = makeService(router);
        await closeChannel(svc, 'carol', ['eve']);
        await svc.handleAction('carol', 'join', { channel: 'room:design' });
        await svc.handleAction('carol', 'send', { channel: 'room:design', message: 'hello' });
        const posted = broadcasts(sendToChannelCalls, 'message').pop();
        sendToChannelCalls.length = 0;

        await svc.handleAction('eve', 'read', { channel: 'room:design', messageId: posted.message.id });
        expect(broadcasts(sendToChannelCalls, 'readReceipt')[0].readAt).toBe(posted.message.timestamp);
    });

    it('clamps a claim to have read the future back to now', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const { svc, receipts } = makeService(router);
        const future = new Date(Date.now() + 86_400_000).toISOString();
        await svc.handleAction('eve', 'read', { channel: 'chat:dm:u-carol:u-eve', at: future });
        expect(broadcasts(sendToChannelCalls, 'readReceipt')[0].readAt).not.toBe(future);
        const stored = (await receipts.listReceipts('chat:dm:u-carol:u-eve'))[0];
        expect(Date.parse(stored.readAt)).toBeLessThanOrEqual(Date.now());
    });

    it('never moves a cursor backwards, and says nothing when it does not move', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const { svc, receipts } = makeService(router);
        await closeChannel(svc, 'carol', ['eve']);
        sendToChannelCalls.length = 0;

        await svc.handleAction('eve', 'read', { channel: 'room:design', at: '2026-09-16T09:00:00.000Z' });
        await svc.handleAction('eve', 'read', { channel: 'room:design', at: '2026-09-16T08:00:00.000Z' });
        await svc.handleAction('eve', 'read', { channel: 'room:design', at: '2026-09-16T09:00:00.000Z' });
        expect(broadcasts(sendToChannelCalls, 'readReceipt')).toHaveLength(1);

        await svc.handleAction('eve', 'read', { channel: 'room:design', at: '2026-09-16T10:00:00.000Z' });
        expect(broadcasts(sendToChannelCalls, 'readReceipt')).toHaveLength(2);
        expect((await receipts.listReceipts('room:design'))[0].readAt).toBe('2026-09-16T10:00:00.000Z');
    });

    it('refuses a read that names a message nobody can find, rather than stamping now', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc } = makeService(router);
        await closeChannel(svc, 'carol', ['eve']);
        sendToChannelCalls.length = 0;
        await svc.handleAction('eve', 'read', { channel: 'room:design', messageId: 'no-such-message' });
        expect(errorsTo(sentToClient, 'eve')[0].error.code).toBe('not-found');
        expect(broadcasts(sendToChannelCalls, 'readReceipt')).toHaveLength(0);
    });
});

describe('ChatService read receipts — who may post one', () => {
    it('refuses a non-member of a closed channel and stores nothing', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc, receipts } = makeService(router);
        await closeChannel(svc, 'carol', ['eve']);
        sendToChannelCalls.length = 0;

        await svc.handleAction('bob', 'read', { channel: 'room:design', at: '2026-09-16T09:00:00.000Z' });
        expect(errorsTo(sentToClient, 'bob')[0].error.code).toBe('not-a-member');
        expect(broadcasts(sendToChannelCalls, 'readReceipt')).toHaveLength(0);
        expect(await receipts.listReceipts('room:design')).toEqual([]);
    });

    it('refuses a non-member of a dm channel', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc, receipts } = makeService(router);
        await svc.handleAction('bob', 'read', { channel: 'chat:dm:u-carol:u-eve', at: '2026-09-16T09:00:00.000Z' });
        expect(errorsTo(sentToClient, 'bob')[0].error.code).toBe('CHAT_DM_FORBIDDEN');
        expect(broadcasts(sendToChannelCalls, 'readReceipt')).toHaveLength(0);
        expect(await receipts.listReceipts('chat:dm:u-carol:u-eve')).toEqual([]);
    });

    it('keeps receipts on a dm channel, whose two members are in its name', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc } = makeService(router);
        await svc.handleAction('eve', 'read', { channel: 'chat:dm:u-carol:u-eve', at: '2026-09-16T09:00:00.000Z' });
        expect(errorsTo(sentToClient, 'eve')).toEqual([]);
        expect(broadcasts(sendToChannelCalls, 'readReceipt')).toHaveLength(1);
    });
});

describe('ChatService read receipts — replay', () => {
    it('answers `receipts` with what was stored, newest reader first, self included', async () => {
        const { router, sentToClient } = makeRouter();
        const { svc } = makeService(router);
        await closeChannel(svc, 'carol', ['eve', 'bob']);

        await svc.handleAction('eve', 'read', { channel: 'room:design', at: '2026-09-16T09:00:00.000Z' });
        await svc.handleAction('bob', 'read', { channel: 'room:design', at: '2026-09-16T11:00:00.000Z' });
        await svc.handleAction('carol', 'receipts', { channel: 'room:design' });

        const frame = framesTo(sentToClient, 'carol', 'receipts').pop();
        expect(frame).toMatchObject({ type: 'chat', channel: 'room:design', enabled: true, limit: 20 });
        expect(frame.receipts).toEqual([
            expect.objectContaining({ userId: 'u-bob', readAt: '2026-09-16T11:00:00.000Z', displayName: 'Bob Martinez' }),
            expect.objectContaining({ userId: 'u-eve', readAt: '2026-09-16T09:00:00.000Z' }),
        ]);
    });

    it('refuses to replay to a non-member', async () => {
        const { router, sentToClient } = makeRouter();
        const { svc } = makeService(router);
        await closeChannel(svc, 'carol', ['eve']);
        await svc.handleAction('bob', 'receipts', { channel: 'room:design' });
        expect(errorsTo(sentToClient, 'bob')[0].error.code).toBe('not-a-member');
        expect(framesTo(sentToClient, 'bob', 'receipts')).toHaveLength(0);
    });
});

describe('ChatService read receipts — where they are kept', () => {
    it('keeps none on an open channel, and says why', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc, receipts } = makeService(router);

        await svc.handleAction('eve', 'receipts', { channel: 'room:open' });
        expect(framesTo(sentToClient, 'eve', 'receipts')[0]).toMatchObject({
            enabled: false, reason: 'open-channel', receipts: [], limit: 20,
        });

        await svc.handleAction('eve', 'read', { channel: 'room:open', at: '2026-09-16T09:00:00.000Z' });
        expect(errorsTo(sentToClient, 'eve')).toEqual([]); // ignored, not an error frame per scroll
        expect(broadcasts(sendToChannelCalls, 'readReceipt')).toHaveLength(0);
        expect(await receipts.listReceipts('room:open')).toEqual([]);
    });

    it('keeps none in a channel bigger than the cap', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc } = makeService(router, { receiptsMaxMembers: 2 });
        await closeChannel(svc, 'carol', ['eve', 'bob']); // three members, cap is two
        sendToChannelCalls.length = 0;

        await svc.handleAction('eve', 'receipts', { channel: 'room:design' });
        expect(framesTo(sentToClient, 'eve', 'receipts').pop()).toMatchObject({
            enabled: false, reason: 'too-many-members', limit: 2,
        });
        await svc.handleAction('eve', 'read', { channel: 'room:design', at: '2026-09-16T09:00:00.000Z' });
        expect(broadcasts(sendToChannelCalls, 'readReceipt')).toHaveLength(0);
    });

    it('keeps none at all when the host passes readReceiptStore: null', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc } = makeService(router, { readReceiptStore: null });
        await closeChannel(svc, 'carol', ['eve']);
        sendToChannelCalls.length = 0;
        await svc.handleAction('eve', 'receipts', { channel: 'room:design' });
        expect(framesTo(sentToClient, 'eve', 'receipts').pop()).toMatchObject({ enabled: false, reason: 'disabled' });
        await svc.handleAction('eve', 'read', { channel: 'room:design', at: '2026-09-16T09:00:00.000Z' });
        expect(broadcasts(sendToChannelCalls, 'readReceipt')).toHaveLength(0);
    });

    it('turns them on when the first add closes a channel, and broadcasts the new state', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const { svc } = makeService(router);
        await closeChannel(svc, 'carol', ['eve']);
        const frame = broadcasts(sendToChannelCalls, 'receipts').pop();
        expect(frame).toMatchObject({ channel: 'room:design', enabled: true, receipts: [] });
    });
});

describe('ChatService read receipts — what disturbs them', () => {
    it('survives an edit and a delete of the message the cursor was taken from', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const { svc, receipts } = makeService(router);
        await closeChannel(svc, 'carol', ['eve']);
        await svc.handleAction('carol', 'join', { channel: 'room:design' });
        await svc.handleAction('carol', 'send', { channel: 'room:design', message: 'first' });
        const posted = broadcasts(sendToChannelCalls, 'message').pop();
        await svc.handleAction('eve', 'read', { channel: 'room:design', messageId: posted.message.id });
        const before = await receipts.listReceipts('room:design');

        await svc.handleAction('carol', 'edit', { channel: 'room:design', messageId: posted.message.id, message: 'second' });
        await svc.handleAction('carol', 'delete', { channel: 'room:design', messageId: posted.message.id });

        // A cursor names a TIME, not a message: nothing to repair, and
        // nobody is marked unread by an edit.
        expect(await receipts.listReceipts('room:design')).toEqual(before);
    });

    it('forgets a removed member\'s cursor and tells the channel the new state', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const { svc, receipts } = makeService(router);
        await closeChannel(svc, 'carol', ['eve', 'bob']);
        await svc.handleAction('eve', 'read', { channel: 'room:design', at: '2026-09-16T09:00:00.000Z' });
        await svc.handleAction('bob', 'read', { channel: 'room:design', at: '2026-09-16T10:00:00.000Z' });
        sendToChannelCalls.length = 0;

        await svc.handleAction('carol', 'removeMember', { channel: 'room:design', userId: 'u-eve' });
        expect((await receipts.listReceipts('room:design')).map((r) => r.userId)).toEqual(['u-bob']);
        const frame = broadcasts(sendToChannelCalls, 'receipts').pop();
        expect(frame.receipts.map((r: any) => r.userId)).toEqual(['u-bob']);
    });

    it('keeps a cursor when the connection merely leaves the channel (a closed tab)', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const { svc, receipts } = makeService(router);
        await closeChannel(svc, 'carol', ['eve']);
        await svc.handleAction('eve', 'join', { channel: 'room:design' });
        await svc.handleAction('eve', 'read', { channel: 'room:design', at: '2026-09-16T09:00:00.000Z' });
        sendToChannelCalls.length = 0;

        await svc.handleAction('eve', 'leave', { channel: 'room:design' });
        await svc.onClientDisconnect('eve');
        expect((await receipts.listReceipts('room:design')).map((r) => r.userId)).toEqual(['u-eve']);
    });

    it('never serves a cursor belonging to someone no longer in the channel', async () => {
        const { router, sentToClient } = makeRouter();
        const { svc, receipts } = makeService(router);
        await closeChannel(svc, 'carol', ['eve']);
        // A row written behind the service's back — another node mid-removal,
        // a crash between the membership write and the delete.
        await receipts.advance({ channel: 'room:design', userId: 'u-ghost', readAt: '2026-09-16T09:00:00.000Z', updatedAt: '2026-09-16T09:00:00.000Z' });
        await svc.handleAction('carol', 'receipts', { channel: 'room:design' });
        expect(framesTo(sentToClient, 'carol', 'receipts').pop().receipts).toEqual([]);
    });
});

describe('MemoryChatReadReceiptStore', () => {
    it('advances only forward and forgets on delete', async () => {
        const store = new MemoryChatReadReceiptStore();
        const base = { channel: 'c', userId: 'u', updatedAt: '2026-09-16T09:00:00.000Z' };
        expect(await store.advance({ ...base, readAt: '2026-09-16T09:00:00.000Z' })).toMatchObject({ readAt: '2026-09-16T09:00:00.000Z' });
        expect(await store.advance({ ...base, readAt: '2026-09-16T08:00:00.000Z' })).toBeNull();
        expect(await store.advance({ ...base, readAt: '2026-09-16T09:00:00.000Z' })).toBeNull();
        expect(await store.advance({ ...base, readAt: '2026-09-16T09:00:00.001Z' })).toMatchObject({ readAt: '2026-09-16T09:00:00.001Z' });
        expect(await store.listReceipts('c')).toHaveLength(1);
        await store.deleteReceipt('c', 'u');
        expect(await store.listReceipts('c')).toEqual([]);
        await store.deleteReceipt('c', 'nobody'); // a no-op, not an error
    });
});
