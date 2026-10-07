// cursorMode 'readers' (0.115): an OPEN channel whose readers the host decides
// per request keeps a cursor per (user, channel) without a roster. `read` asks
// the router's subscribe authority (a cursor is reader state), every frame;
// the receipt fans out with no publisher so the router's per-recipient check
// limits it to current readers; listed cursors go through `currentReaders`.
import { describe, it, expect, jest } from '@jest/globals';
import { ChatService } from '../../src/chat/ChatService';
import { InMemoryChatStore } from '../../src/chat/ChatStore';
import { MemoryChatMembershipStore } from '../../src/chat/ChatMembershipStore';
import { MemoryChatReadReceiptStore } from '../../src/chat/ChatReadReceiptStore';

class NoopLogger { info() {} warn() {} error() {} debug() {} }

const IDS: Record<string, { userId: string; displayName: string }> = {
    eve: { userId: 'u-eve', displayName: 'Eve Thompson' },
    carol: { userId: 'u-carol', displayName: 'Carol Johnson' },
    bob: { userId: 'u-bob', displayName: 'Bob Martinez' },
};

const PAGE = 'page:team:1';

/** A router whose channel authz is a mutable table: `deny` holds `${kind}:${clientId}`. */
function makeRouter() {
    const sentToClient: any[] = [];
    const sendToChannelCalls: any[] = [];
    const checks: Array<{ kind: string; clientId: string; channel: string }> = [];
    const deny = new Set<string>();
    const router: any = {
        redisAvailable: false,
        sendToClient: jest.fn((clientId: string, message: any) => { sentToClient.push({ clientId, message }); }),
        sendToChannel: jest.fn(async (channel: string, message: any, excludeClientId?: string | null, opts?: any) => {
            sendToChannelCalls.push({ channel, message, excludeClientId, opts });
        }),
        subscribeToChannel: jest.fn(async () => true),
        unsubscribeFromChannel: jest.fn(async () => undefined),
        getClientData: jest.fn(() => ({})),
        checkChannel: jest.fn(async (kind: string, clientId: string, channel: string) => {
            checks.push({ kind, clientId, channel });
            return !deny.has(`${kind}:${clientId}`);
        }),
    };
    return { router, sentToClient, sendToChannelCalls, checks, deny };
}

function makeService(router: any, extra: Record<string, unknown> = {}) {
    const members = new MemoryChatMembershipStore();
    const receipts = new MemoryChatReadReceiptStore();
    const seen: any[] = [];
    const svc = new ChatService({
        messageRouter: router,
        logger: new NoopLogger() as any,
        chatStore: new InMemoryChatStore(),
        membershipStore: members,
        readReceiptStore: receipts,
        identityResolver: (clientId: string) => IDS[clientId] ?? null,
        onReadReceipt: (info: any) => seen.push(info),
        cursorMode: (channel: string) => (channel.startsWith('page:') ? 'readers' : 'members'),
        ...extra,
    } as any);
    return { svc, members, receipts, seen };
}

const framesTo = (sent: any[], clientId: string, action: string) =>
    sent.filter((s) => s.clientId === clientId && s.message.action === action).map((s) => s.message);
const errorsTo = (sent: any[], clientId: string) =>
    sent.filter((s) => s.clientId === clientId && s.message.type === 'error').map((s) => s.message);
const broadcasts = (calls: any[], action: string) => calls.filter((c) => c.message.action === action);

describe('ChatService cursorMode readers — an open page discussion keeps cursors', () => {
    it('stores a reader\'s cursor, admitted by the subscribe authority, and fans out with no publisher', async () => {
        const { router, sentToClient, sendToChannelCalls, checks } = makeRouter();
        const { svc, receipts, seen } = makeService(router);

        await svc.handleAction('eve', 'read', { channel: PAGE, at: '2026-10-06T09:00:00.000Z' });
        expect(errorsTo(sentToClient, 'eve')).toEqual([]);
        // Asked as a READ, before and after the write; never as a publish.
        expect(checks.filter((c) => c.clientId === 'eve').map((c) => c.kind)).toEqual(['subscribe', 'subscribe']);
        const out = broadcasts(sendToChannelCalls, 'readReceipt');
        expect(out).toHaveLength(1);
        expect(out[0].message).toMatchObject({ channel: PAGE, userId: 'u-eve', readAt: '2026-10-06T09:00:00.000Z' });
        expect(out[0].excludeClientId).toBeUndefined();
        expect(out[0].opts).toBeUndefined(); // no publisher: the router's per-recipient check decides
        expect(await receipts.listReceipts(PAGE)).toEqual([expect.objectContaining({ userId: 'u-eve' })]);
        expect(seen).toHaveLength(1);

        await svc.handleAction('eve', 'receipts', { channel: PAGE });
        expect(framesTo(sentToClient, 'eve', 'receipts').pop()).toMatchObject({
            enabled: true, mode: 'readers',
            receipts: [expect.objectContaining({ userId: 'u-eve', readAt: '2026-10-06T09:00:00.000Z' })],
        });
    });

    it('refuses an outsider: no cursor, no fan-out, the router\'s refusal is the answer', async () => {
        const { router, sendToChannelCalls, deny } = makeRouter();
        const { svc, receipts, seen } = makeService(router);
        deny.add('subscribe:bob');

        await svc.handleAction('bob', 'read', { channel: PAGE, at: '2026-10-06T09:00:00.000Z' });
        await svc.handleAction('bob', 'receipts', { channel: PAGE });
        expect(await receipts.listReceipts(PAGE)).toEqual([]);
        expect(broadcasts(sendToChannelCalls, 'readReceipt')).toHaveLength(0);
        expect(seen).toHaveLength(0);
    });

    it('a revocation during the store write broadcasts nothing and fires no hook', async () => {
        const { router, sendToChannelCalls, deny } = makeRouter();
        const { svc, receipts, seen } = makeService(router);
        const advance = receipts.advance.bind(receipts);
        receipts.advance = async (r) => { const out = await advance(r); deny.add('subscribe:eve'); return out; };

        await svc.handleAction('eve', 'read', { channel: PAGE, at: '2026-10-06T09:00:00.000Z' });
        expect(broadcasts(sendToChannelCalls, 'readReceipt')).toHaveLength(0);
        expect(seen).toHaveLength(0);
    });

    it('lists only the cursors of current readers (currentReaders), failing closed', async () => {
        const { router, sentToClient } = makeRouter();
        let readers = ['u-eve', 'u-carol'];
        let fail = false;
        const { svc } = makeService(router, {
            currentReaders: async (_channel: string, ids: readonly string[]) => {
                if (fail) throw new Error('directory down');
                return ids.filter((id) => readers.includes(id));
            },
        });
        await svc.handleAction('eve', 'read', { channel: PAGE, at: '2026-10-06T09:00:00.000Z' });
        await svc.handleAction('carol', 'read', { channel: PAGE, at: '2026-10-06T09:05:00.000Z' });

        await svc.handleAction('eve', 'receipts', { channel: PAGE });
        expect(framesTo(sentToClient, 'eve', 'receipts').pop().receipts.map((r: any) => r.userId)).toEqual(['u-carol', 'u-eve']);

        readers = ['u-eve']; // Carol lost access: her cursor stays stored but is never reported
        await svc.handleAction('eve', 'receipts', { channel: PAGE });
        expect(framesTo(sentToClient, 'eve', 'receipts').pop().receipts.map((r: any) => r.userId)).toEqual(['u-eve']);

        fail = true;
        await svc.handleAction('eve', 'receipts', { channel: PAGE });
        expect(framesTo(sentToClient, 'eve', 'receipts').pop()).toMatchObject({ enabled: true, receipts: [] });
    });

    it('has no member cap, and stays monotonic', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const { svc } = makeService(router, { receiptsMaxMembers: 1 });
        await svc.handleAction('eve', 'read', { channel: PAGE, at: '2026-10-06T09:00:00.000Z' });
        await svc.handleAction('carol', 'read', { channel: PAGE, at: '2026-10-06T09:00:00.000Z' });
        await svc.handleAction('eve', 'read', { channel: PAGE, at: '2026-10-06T08:00:00.000Z' });
        expect(broadcasts(sendToChannelCalls, 'readReceipt')).toHaveLength(2);
    });

    it('leaves members mode alone: other open channels stay off, a closed one keeps its roster rule', async () => {
        const { router, sentToClient, checks } = makeRouter();
        const { svc } = makeService(router);
        await svc.handleAction('eve', 'receipts', { channel: 'room:open' });
        expect(framesTo(sentToClient, 'eve', 'receipts').pop()).toMatchObject({ enabled: false, reason: 'open-channel' });
        checks.length = 0;
        await svc.handleAction('eve', 'read', { channel: 'room:open', at: '2026-10-06T09:00:00.000Z' });
        expect(checks[0]).toMatchObject({ kind: 'publish', clientId: 'eve' }); // unchanged: read is a publish there

        // A page channel that gains membership rows is closed: members only.
        await svc.handleAction('carol', 'addMembers', { channel: PAGE, userIds: ['u-eve'], history: { mode: 'all' } });
        await svc.handleAction('bob', 'read', { channel: PAGE, at: '2026-10-06T09:00:00.000Z' });
        expect(errorsTo(sentToClient, 'bob').map((e) => e.error?.code ?? e.code)).toContain('not-a-member');
        await svc.handleAction('eve', 'receipts', { channel: PAGE });
        expect(framesTo(sentToClient, 'eve', 'receipts').pop()).toMatchObject({ enabled: true });
        expect(framesTo(sentToClient, 'eve', 'receipts').pop().mode).toBeUndefined();
    });

    it('never applies to a dm, and a throwing cursorMode hook means members', async () => {
        const { router, sentToClient } = makeRouter();
        const { svc } = makeService(router, { cursorMode: () => { throw new Error('boom'); } });
        await svc.handleAction('eve', 'receipts', { channel: PAGE });
        expect(framesTo(sentToClient, 'eve', 'receipts').pop()).toMatchObject({ enabled: false, reason: 'open-channel' });
        const { svc: dmSvc } = makeService(router, { cursorMode: () => 'readers' });
        await dmSvc.handleAction('eve', 'receipts', { channel: 'chat:dm:u-carol:u-eve' });
        expect(framesTo(sentToClient, 'eve', 'receipts').pop()).toMatchObject({ enabled: true });
        expect(framesTo(sentToClient, 'eve', 'receipts').pop().mode).toBeUndefined();
    });

    it('an anonymous connection keeps no cursor', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc } = makeService(router);
        await svc.handleAction('nobody', 'read', { channel: PAGE, at: '2026-10-06T09:00:00.000Z' });
        expect(errorsTo(sentToClient, 'nobody')).toHaveLength(1);
        expect(broadcasts(sendToChannelCalls, 'readReceipt')).toHaveLength(0);
    });
});
