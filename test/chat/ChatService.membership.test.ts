// Membership: a channel with no rows is open; the first add closes it and
// makes the adder its owner; members read from their own history floor;
// a removed member is refused; the thread is told.
import { describe, it, expect, jest } from '@jest/globals';
import { ChatService } from '../../src/chat/ChatService';
import { MemoryChatMembershipStore, historyFloorFor, parseHistoryChoice } from '../../src/chat/ChatMembershipStore';

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
};

function makeService(router: any, store = new MemoryChatMembershipStore()) {
    const svc = new ChatService({
        messageRouter: router,
        logger: new NoopLogger() as any,
        membershipStore: store,
        identityResolver: (clientId: string) => IDS[clientId] ?? null,
    } as any);
    return { svc, store };
}

const framesTo = (sent: any[], clientId: string, action: string) => sent.filter((s) => s.clientId === clientId && s.message.action === action).map((s) => s.message);
const errorsTo = (sent: any[], clientId: string) => sent.filter((s) => s.clientId === clientId && s.message.type === 'error').map((s) => s.message);

describe('history choice', () => {
    it('parses the three modes and clamps days', () => {
        expect(parseHistoryChoice({ mode: 'all' })).toEqual({ mode: 'all' });
        expect(parseHistoryChoice({ mode: 'none' })).toEqual({ mode: 'none' });
        expect(parseHistoryChoice({ mode: 'days', days: 7 })).toEqual({ mode: 'days', days: 7 });
        expect(parseHistoryChoice({ mode: 'days', days: 99999 })).toEqual({ mode: 'days', days: 3650 });
        expect(parseHistoryChoice({ mode: 'days' })).toBeNull();
        expect(parseHistoryChoice({ mode: 'weeks' })).toBeNull();
        expect(parseHistoryChoice('all')).toBeNull();
    });
    it('turns a choice into a floor', () => {
        const now = Date.parse('2026-09-16T00:00:00Z');
        expect(historyFloorFor({ mode: 'all' }, now)).toBeNull();
        expect(historyFloorFor({ mode: 'none' }, now)).toBe('2026-09-16T00:00:00.000Z');
        expect(historyFloorFor({ mode: 'days', days: 7 }, now)).toBe('2026-09-09T00:00:00.000Z');
    });
});

describe('ChatService membership', () => {
    it('reports an open channel with no members, and a dm channel from its name', async () => {
        const { router, sentToClient } = makeRouter();
        const { svc } = makeService(router);
        await svc.handleAction('eve', 'members', { channel: 'room:design' });
        expect(framesTo(sentToClient, 'eve', 'members')[0]).toMatchObject({ type: 'chat', channel: 'room:design', open: true, members: [] });
        await svc.handleAction('eve', 'members', { channel: 'chat:dm:u-carol:u-eve' });
        const dm = framesTo(sentToClient, 'eve', 'members')[1];
        expect(dm.open).toBe(false);
        expect(dm.members.map((m: any) => m.userId).sort()).toEqual(['u-carol', 'u-eve']);
    });

    it('the first add closes the channel, owns it to the adder, floors the added, tells the thread and the room', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc, store } = makeService(router);
        await svc.handleAction('eve', 'join', { channel: 'room:design' });
        await svc.handleAction('eve', 'send', { channel: 'room:design', message: 'before carol' });
        sendToChannelCalls.length = 0;

        await svc.handleAction('eve', 'addMembers', { channel: 'room:design', userIds: ['u-carol'], history: { mode: 'days', days: 7 }, names: { 'u-carol': 'Carol Johnson' } });

        const rows = await store.listMembers('room:design');
        expect(rows.find((r) => r.userId === 'u-eve')).toMatchObject({ role: 'owner', historyFrom: null, removedAt: null });
        const carol = rows.find((r) => r.userId === 'u-carol')!;
        expect(carol).toMatchObject({ role: 'member', addedBy: 'u-eve', removedAt: null });
        expect(typeof carol.historyFrom).toBe('string');

        // The thread got a stored membership message from Eve…
        const posted = sendToChannelCalls.find((c) => c.message.action === 'message');
        expect(posted.message.message).toMatchObject({ userId: 'u-eve', message: 'Eve Thompson added Carol Johnson' });
        expect(posted.message.message.metadata).toMatchObject({ kind: 'membership', event: 'added', actorId: 'u-eve', userIds: ['u-carol'], history: { mode: 'days', days: 7 } });
        // …and everyone got the roster.
        const updated = sendToChannelCalls.find((c) => c.message.action === 'membersUpdated');
        expect(updated.message).toMatchObject({ type: 'chat', channel: 'room:design', open: false });
        expect(updated.message.members.map((m: any) => m.userId).sort()).toEqual(['u-carol', 'u-eve']);
        expect(framesTo(sentToClient, 'eve', 'membersUpdated')).toHaveLength(1);
    });

    it('refuses a non-member on a closed channel, for join, send, history and adding', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc } = makeService(router);
        await svc.handleAction('eve', 'addMembers', { channel: 'room:design', userIds: ['u-carol'], history: { mode: 'all' } });
        sentToClient.length = 0;
        await svc.handleAction('bob', 'join', { channel: 'room:design' });
        await svc.handleAction('bob', 'history', { channel: 'room:design' });
        await svc.handleAction('bob', 'addMembers', { channel: 'room:design', userIds: ['u-bob'], history: { mode: 'all' } });
        const errs = errorsTo(sentToClient, 'bob');
        expect(errs.length).toBe(3);
        expect(errs.every((e) => e.error.code === 'not-a-member' && e.channel === 'room:design')).toBe(true);
        expect(framesTo(sentToClient, 'bob', 'joined')).toHaveLength(0);
        expect(router.subscribeToChannel).not.toHaveBeenCalledWith('bob', 'room:design');
        // and a connection with no identity is refused too (fail closed)
        await svc.handleAction('nobody', 'join', { channel: 'room:design' });
        expect(errorsTo(sentToClient, 'nobody')[0].error.code).toBe('not-a-member');
        expect(sendToChannelCalls.filter((c) => c.message.action === 'message')).toHaveLength(1);
    });

    it('a member reads history from their floor only', async () => {
        const { router, sentToClient } = makeRouter();
        const { svc } = makeService(router);
        await svc.handleAction('eve', 'join', { channel: 'room:design' });
        await svc.handleAction('eve', 'send', { channel: 'room:design', message: 'old' });
        // A floor is a timestamp: give the clock a tick on either side of it.
        await new Promise((r) => setTimeout(r, 5));
        await svc.handleAction('eve', 'addMembers', { channel: 'room:design', userIds: ['u-carol'], history: { mode: 'none' } });
        await new Promise((r) => setTimeout(r, 5));
        await svc.handleAction('eve', 'send', { channel: 'room:design', message: 'new' });
        sentToClient.length = 0;
        await svc.handleAction('carol', 'join', { channel: 'room:design' });
        const hist = framesTo(sentToClient, 'carol', 'history')[0];
        const texts = hist.messages.map((m: any) => m.message);
        expect(texts).not.toContain('old');
        expect(texts).toContain('new');
        // The owner (no floor) sees everything, including the membership line.
        expect((await svc.getChannelHistoryFor('u-eve', 'room:design', 50)).map((m) => m.message)).toEqual(['old', 'Eve Thompson added u-carol', 'new']);
        // A stranger sees nothing.
        expect(await svc.getChannelHistoryFor('u-bob', 'room:design', 50)).toEqual([]);
    });

    // The same-millisecond case, pinned rather than left to the clock. This
    // test used to exist only by accident: the suite below re-added a member
    // with mode 'none' and asserted the old message was hidden, which held
    // whenever a millisecond happened to tick between the send and the add and
    // failed when it did not. Freezing the clock makes the collision certain.
    it('mode none hides a message stamped the very millisecond of the add', async () => {
        // setSystemTime, not a Date.now spy. The floor comes from Date.now()
        // but a message is stamped with `new Date().toISOString()`, which a
        // spy on Date.now does not touch — so the original version of this
        // test only passed while the real wall clock happened to sit before
        // the frozen instant, and started failing the moment it went past.
        // A test that changes its answer at midday is worse than the flake it
        // was written to replace.
        //
        // Timers stay real: ChatService runs a periodic cache sweep and this
        // test has no reason to drive it.
        jest.useFakeTimers({ doNotFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'nextTick'] });
        jest.setSystemTime(Date.parse('2026-09-18T12:00:00.000Z'));
        try {
            const { router } = makeRouter();
            const { svc, store } = makeService(router);
            await svc.handleAction('eve', 'join', { channel: 'room:frozen' });
            await svc.handleAction('eve', 'send', { channel: 'room:frozen', message: 'before' });
            await svc.handleAction('eve', 'addMembers', {
                channel: 'room:frozen',
                userIds: ['u-carol'],
                history: { mode: 'none' },
            });

            // Floor and message share an instant exactly.
            const row = (await store.getMember('room:frozen', 'u-carol'))!;
            expect(row.historyFrom).toBe('2026-09-18T12:00:00.000Z');

            const seen = (await svc.getChannelHistoryFor('u-carol', 'room:frozen', 50)).map((m) => m.message);
            expect(seen).not.toContain('before');
        } finally {
            jest.useRealTimers();
        }
    });

    it('all-history keeps no floor; a removed member is out until re-added with a new floor', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc, store } = makeService(router);
        await svc.handleAction('eve', 'join', { channel: 'room:design' });
        await svc.handleAction('eve', 'send', { channel: 'room:design', message: 'old' });
        await svc.handleAction('eve', 'addMembers', { channel: 'room:design', userIds: ['u-carol'], history: { mode: 'all' } });
        await svc.handleAction('carol', 'join', { channel: 'room:design' });
        expect((await store.getMember('room:design', 'u-carol'))!.historyFrom).toBeNull();
        expect((await svc.getChannelHistoryFor('u-carol', 'room:design', 50)).map((m) => m.message)).toContain('old');

        // Carol may not remove Eve; Eve (owner) may remove Carol.
        await svc.handleAction('carol', 'removeMember', { channel: 'room:design', userId: 'u-eve' });
        expect(errorsTo(sentToClient, 'carol').pop().error.code).toBe('forbidden');
        await svc.handleAction('eve', 'removeMember', { channel: 'room:design', userId: 'u-carol', name: 'Carol Johnson' });
        expect((await store.getMember('room:design', 'u-carol'))!.removedAt).toBeTruthy();
        const removedLine = sendToChannelCalls.filter((c) => c.message.action === 'message').pop();
        expect(removedLine.message.message).toMatchObject({ message: 'Eve Thompson removed Carol Johnson' });
        expect(removedLine.message.message.metadata).toMatchObject({ kind: 'membership', event: 'removed', userIds: ['u-carol'] });
        expect(await svc.getChannelHistoryFor('u-carol', 'room:design', 50)).toEqual([]);
        sentToClient.length = 0;
        await svc.handleAction('carol', 'send', { channel: 'room:design', message: 'still here?' });
        expect(errorsTo(sentToClient, 'carol')[0].error.code).toBe('not-a-member');

        // Re-added with "none": back in, but only from now.
        await svc.handleAction('eve', 'addMembers', { channel: 'room:design', userIds: ['u-carol'], history: { mode: 'none' } });
        const again = (await store.getMember('room:design', 'u-carol'))!;
        expect(again.removedAt).toBeNull();
        expect(typeof again.historyFrom).toBe('string');
        expect((await svc.getChannelHistoryFor('u-carol', 'room:design', 50)).map((m) => m.message)).not.toContain('old');
    });

    it('a member may leave (remove themselves)', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const { svc, store } = makeService(router);
        await svc.handleAction('eve', 'addMembers', { channel: 'room:design', userIds: ['u-carol'], history: { mode: 'all' } });
        await svc.handleAction('carol', 'removeMember', { channel: 'room:design', userId: 'u-carol' });
        expect((await store.getMember('room:design', 'u-carol'))!.removedAt).toBeTruthy();
        expect(sendToChannelCalls.filter((c) => c.message.action === 'message').pop().message.message.message).toBe('Carol Johnson left');
    });

    it('rejects malformed requests and dm channels', async () => {
        const { router, sentToClient } = makeRouter();
        const { svc } = makeService(router);
        await svc.handleAction('eve', 'addMembers', { channel: 'room:design', userIds: [], history: { mode: 'all' } });
        await svc.handleAction('eve', 'addMembers', { channel: 'room:design', userIds: ['u-carol'], history: { mode: 'sometimes' } });
        await svc.handleAction('eve', 'addMembers', { channel: 'chat:dm:u-carol:u-eve', userIds: ['u-bob'], history: { mode: 'all' } });
        expect(errorsTo(sentToClient, 'eve').map((e) => e.error.code)).toEqual(['bad-request', 'bad-request', 'bad-request']);
    });

    it('without a membership store every channel stays open and the actions say so', async () => {
        const { router, sentToClient } = makeRouter();
        const svc = new ChatService({ messageRouter: router, logger: new NoopLogger() as any, identityResolver: (c: string) => IDS[c] ?? null } as any);
        await svc.handleAction('eve', 'members', { channel: 'room:design' });
        expect(framesTo(sentToClient, 'eve', 'members')[0]).toMatchObject({ open: true, members: [] });
        await svc.handleAction('eve', 'addMembers', { channel: 'room:design', userIds: ['u-carol'], history: { mode: 'all' } });
        expect(errorsTo(sentToClient, 'eve')[0].error.code).toBe('bad-request');
    });
});

describe('ChatService membership — removal evicts live connections', () => {
    /** A router that actually delivers: subscribed clients get every channel frame, like the gateway's local router. */
    function makeDeliveringRouter() {
        const inbox: Record<string, any[]> = {};
        const subs = new Map<string, Set<string>>();
        const router: any = {
            redisAvailable: false,
            sendToClient: jest.fn((clientId: string, message: any) => { (inbox[clientId] ??= []).push(message); }),
            sendToChannel: jest.fn(async (channel: string, message: any, excludeClientId?: string | null) => {
                for (const c of subs.get(channel) ?? []) if (c !== excludeClientId) (inbox[c] ??= []).push(message);
            }),
            subscribeToChannel: jest.fn(async (clientId: string, channel: string) => { (subs.get(channel) ?? subs.set(channel, new Set()).get(channel)!).add(clientId); return true; }),
            unsubscribeFromChannel: jest.fn(async (clientId: string, channel: string) => { subs.get(channel)?.delete(clientId); }),
            getClientData: jest.fn(() => ({})),
        };
        return { router, inbox, subs };
    }

    it('B is told, unsubscribed, and hears nothing further; A still gets membersUpdated', async () => {
        const { router, inbox, subs } = makeDeliveringRouter();
        const { svc } = makeService(router);
        await svc.handleAction('eve', 'addMembers', { channel: 'room:design', userIds: ['u-bob'], history: { mode: 'all' } });
        await svc.handleAction('eve', 'join', { channel: 'room:design' });
        await svc.handleAction('bob', 'join', { channel: 'room:design' });
        expect(subs.get('room:design')).toEqual(new Set(['eve', 'bob']));
        inbox.eve = []; inbox.bob = [];

        await svc.handleAction('eve', 'removeMember', { channel: 'room:design', userId: 'u-bob', name: 'Bob Martinez' });

        const removed = inbox.bob.find((m) => m.type === 'chat' && m.action === 'removed');
        expect(removed).toMatchObject({ type: 'chat', action: 'removed', channel: 'room:design', byUserId: 'u-eve' });
        expect(typeof removed.timestamp).toBe('string');
        expect(subs.get('room:design')).toEqual(new Set(['eve']));
        // Bob did not get the "removed Bob" line nor the roster.
        expect(inbox.bob.filter((m) => m.action === 'message' || m.action === 'membersUpdated')).toEqual([]);
        // Eve got the line and the roster without Bob.
        expect(inbox.eve.find((m) => m.action === 'message')?.message?.message).toBe('Eve Thompson removed Bob Martinez');
        const roster = inbox.eve.find((m) => m.action === 'membersUpdated');
        expect(roster.members.map((m: any) => m.userId)).toEqual(['u-eve']);

        inbox.bob = [];
        await svc.handleAction('eve', 'send', { channel: 'room:design', message: 'after bob' });
        expect(inbox.bob).toEqual([]);
        expect(inbox.eve.some((m) => m.action === 'message' && m.message?.message === 'after bob')).toBe(true);
    });

    it('leaving evicts your own connection too', async () => {
        const { router, inbox, subs } = makeDeliveringRouter();
        const { svc } = makeService(router);
        await svc.handleAction('eve', 'addMembers', { channel: 'room:design', userIds: ['u-carol'], history: { mode: 'all' } });
        await svc.handleAction('carol', 'join', { channel: 'room:design' });
        inbox.carol = [];
        await svc.handleAction('carol', 'removeMember', { channel: 'room:design', userId: 'u-carol' });
        expect(inbox.carol.find((m) => m.action === 'removed')).toMatchObject({ byUserId: 'u-carol' });
        expect(subs.get('room:design')?.has('carol')).toBe(false);
    });
});

describe('ChatService onChannelMessage seam', () => {
    it('names a closed channel\'s active members, minus the sender', async () => {
        const calls: any[] = [];
        const { router } = makeRouter();
        const store = new MemoryChatMembershipStore();
        const svc = new ChatService({
            messageRouter: router,
            logger: new NoopLogger() as any,
            membershipStore: store,
            identityResolver: (clientId: string) => IDS[clientId] ?? null,
            onChannelMessage: (info: any) => calls.push(info),
        } as any);
        await svc.handleAction('eve', 'join', { channel: 'room:design' });
        await svc.handleAction('eve', 'addMembers', { channel: 'room:design', userIds: ['u-carol', 'u-bob'], history: { mode: 'all' } });
        await svc.handleAction('eve', 'removeMember', { channel: 'room:design', userId: 'u-bob' });
        calls.length = 0;
        await svc.handleAction('eve', 'send', { channel: 'room:design', message: 'hello members' });
        expect(calls).toHaveLength(1);
        expect(calls[0].channel).toBe('room:design');
        expect(calls[0].members).toEqual(['u-carol']);
        expect(calls[0].message.message).toBe('hello members');
    });

    it('names an open channel\'s current subscribers, minus the sender', async () => {
        const calls: any[] = [];
        const { router } = makeRouter();
        const svc = new ChatService({
            messageRouter: router,
            logger: new NoopLogger() as any,
            membershipStore: new MemoryChatMembershipStore(),
            identityResolver: (clientId: string) => IDS[clientId] ?? null,
            onChannelMessage: (info: any) => calls.push(info),
        } as any);
        await svc.handleAction('eve', 'join', { channel: 'general' });
        await svc.handleAction('carol', 'join', { channel: 'general' });
        await svc.handleAction('carol', 'send', { channel: 'general', message: 'hi all' });
        expect(calls).toHaveLength(1);
        expect(calls[0].members).toEqual(['u-eve']);
    });

    it('does not fire for a dm channel', async () => {
        const calls: any[] = [];
        const { router } = makeRouter();
        const svc = new ChatService({
            messageRouter: router,
            logger: new NoopLogger() as any,
            membershipStore: new MemoryChatMembershipStore(),
            identityResolver: (clientId: string) => IDS[clientId] ?? null,
            onChannelMessage: (info: any) => calls.push(info),
        } as any);
        const dm = 'chat:dm:u-carol:u-eve';
        await svc.handleAction('eve', 'join', { channel: dm });
        await svc.handleAction('eve', 'send', { channel: dm, message: 'just us' });
        expect(calls).toHaveLength(0);
    });
});

describe('ChatService open-channel audience', () => {
    it('records joins on non-dm channels only', async () => {
        const joins: any[] = [];
        const { router } = makeRouter();
        const svc = new ChatService({
            messageRouter: router,
            logger: new NoopLogger() as any,
            membershipStore: new MemoryChatMembershipStore(),
            identityResolver: (clientId: string) => IDS[clientId] ?? null,
            onChannelJoin: (info: any) => joins.push(info),
        } as any);
        await svc.handleAction('eve', 'join', { channel: 'general' });
        await svc.handleAction('eve', 'join', { channel: 'chat:dm:u-carol:u-eve' });
        expect(joins).toEqual([{ channel: 'general', userId: 'u-eve' }]);
    });

    it('unions the host audience with the subscribers for an open channel, minus the sender', async () => {
        const calls: any[] = [];
        const { router } = makeRouter();
        const svc = new ChatService({
            messageRouter: router,
            logger: new NoopLogger() as any,
            membershipStore: new MemoryChatMembershipStore(),
            identityResolver: (clientId: string) => IDS[clientId] ?? null,
            onChannelMessage: (info: any) => calls.push(info),
            channelAudience: async (channel: string) => (channel === 'general' ? ['u-bob', 'u-carol', 'u-eve'] : []),
        } as any);
        await svc.handleAction('eve', 'join', { channel: 'general' });
        await svc.handleAction('carol', 'join', { channel: 'general' });
        await svc.handleAction('carol', 'send', { channel: 'general', message: 'hi all' });
        expect(calls).toHaveLength(1);
        expect(calls[0].members.sort()).toEqual(['u-bob', 'u-eve']);
    });

    it('does not ask the host audience for a closed channel', async () => {
        const calls: any[] = [];
        const asked: string[] = [];
        const { router } = makeRouter();
        const svc = new ChatService({
            messageRouter: router,
            logger: new NoopLogger() as any,
            membershipStore: new MemoryChatMembershipStore(),
            identityResolver: (clientId: string) => IDS[clientId] ?? null,
            onChannelMessage: (info: any) => calls.push(info),
            channelAudience: async (channel: string) => { asked.push(channel); return ['u-bob']; },
        } as any);
        await svc.handleAction('eve', 'join', { channel: 'room:design' });
        await svc.handleAction('eve', 'addMembers', { channel: 'room:design', userIds: ['u-carol'], history: { mode: 'all' } });
        calls.length = 0;
        await svc.handleAction('eve', 'send', { channel: 'room:design', message: 'members only' });
        expect(calls[0].members).toEqual(['u-carol']);
        expect(asked).toEqual([]);
    });
});
