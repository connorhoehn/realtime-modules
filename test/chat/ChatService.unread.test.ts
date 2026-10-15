// 0.118 (lane R5): chat({ unread }) owns the "new messages" item per cursor
// holder, for client sends and server-side posts alike, clears it on receipt,
// and creates one only for someone who reads the channel NOW.
import { describe, it, expect, jest } from '@jest/globals';
import { ChatService } from '../../src/chat/ChatService';
import { InMemoryChatStore } from '../../src/chat/ChatStore';
import { MemoryChatMembershipStore } from '../../src/chat/ChatMembershipStore';
import { MemoryChatReadReceiptStore } from '../../src/chat/ChatReadReceiptStore';

class NoopLogger { info() {} warn() {} error() {} debug() {} }
const PAGE = 'page:team:1';
const IDS: Record<string, { userId: string; displayName: string }> = {
    eve: { userId: 'u-eve', displayName: 'Eve' },
    carol: { userId: 'u-carol', displayName: 'Carol' },
    bob: { userId: 'u-bob', displayName: 'Bob' },
};

function fakeInbox() {
    const rows = new Map<string, any[]>();
    return {
        rows,
        notifyUser: jest.fn(async (u: string, i: any) => { rows.set(u, [...(rows.get(u) ?? []), { ...i }]); }),
        listForUser: async (u: string) => rows.get(u) ?? [],
        markReadForUser: jest.fn(async (u: string, ids: readonly string[]) => { for (const r of rows.get(u) ?? []) if (ids.includes(r.id)) r.read = true; }),
    };
}

function setup(extra: Record<string, unknown> = {}) {
    const router: any = {
        redisAvailable: false,
        sendToClient: jest.fn(),
        sendToChannel: jest.fn(async () => undefined),
        subscribeToChannel: jest.fn(async () => true),
        getClientData: jest.fn(() => ({})),
        checkChannel: jest.fn(async () => true),
    };
    const inbox = fakeInbox();
    let readers = new Set(['u-eve', 'u-carol', 'u-bob']);
    const currentReaders = jest.fn(async (_c: string, ids: readonly string[]) => ids.filter((i) => readers.has(i)));
    const receipts = new MemoryChatReadReceiptStore();
    const svc = new ChatService({
        messageRouter: router, logger: new NoopLogger() as any,
        chatStore: new InMemoryChatStore(), membershipStore: new MemoryChatMembershipStore(), readReceiptStore: receipts,
        identityResolver: (c: string) => IDS[c] ?? null,
        cursorMode: (c: string) => (c.startsWith('page:') ? 'readers' : 'members'),
        currentReaders,
        unread: {
            notify: inbox as any,
            itemId: (c: string, at: string | null) => `unread:${c}:${at ?? 'never'}`,
            describe: ({ message, recipient }: any) => ({ title: `New in team (${recipient})`, body: message.message }),
        },
        ...extra,
    } as any);
    return { svc, inbox, receipts, currentReaders, revoke: (u: string) => readers.delete(u) };
}

const T0 = '2026-10-14T09:00:00.000Z';
const seedCursor = (r: MemoryChatReadReceiptStore, userId: string, at = T0) => r.advance({ channel: PAGE, userId, readAt: at, updatedAt: at } as any);

describe('chat unread items', () => {
    it('gives one item per current reader with a cursor, not the sender, and clears it on receipt', async () => {
        const { svc, inbox, receipts } = setup();
        await seedCursor(receipts, 'u-eve'); await seedCursor(receipts, 'u-carol'); await seedCursor(receipts, 'u-bob');
        await svc.handleAction('bob', 'join', { channel: PAGE });
        await svc.handleAction('bob', 'send', { channel: PAGE, message: 'hello page' });
        expect([...inbox.rows.keys()].sort()).toEqual(['u-carol', 'u-eve']);
        expect(inbox.rows.get('u-eve')![0]).toMatchObject({ id: `unread:${PAGE}:${T0}`, channel: PAGE, body: 'hello page' });

        // a second message in the same stretch does not make a second item
        await svc.handleAction('bob', 'send', { channel: PAGE, message: 'again' });
        expect(inbox.rows.get('u-eve')).toHaveLength(1);

        await svc.handleAction('eve', 'read', { channel: PAGE });
        expect(inbox.rows.get('u-eve')![0].read).toBe(true);
        expect(inbox.rows.get('u-carol')![0].read).toBeUndefined();
    });

    it('server-side posts take the same path', async () => {
        const { svc, inbox, receipts } = setup();
        await seedCursor(receipts, 'u-eve');
        await svc.postSystemMessage(PAGE, 'run finished');
        expect(inbox.rows.get('u-eve')).toHaveLength(1);
        // and a host that writes the store itself can call noteMessagePosted
        const given = await svc.noteMessagePosted(PAGE, { id: 'm9', clientId: 'x', channel: PAGE, message: 'direct', timestamp: '2026-10-14T10:00:00.000Z', userId: 'u-bob' }, { sender: 'u-bob' });
        expect(given).toEqual([]); // same stretch: already has its item
    });

    it('a reader revoked between post and item gets nothing, asked fresh per recipient', async () => {
        const { svc, inbox, receipts, currentReaders, revoke } = setup();
        await seedCursor(receipts, 'u-eve'); await seedCursor(receipts, 'u-carol');
        let calls = 0;
        currentReaders.mockImplementation(async (_c, ids) => {
            calls++;
            if (calls === 2) revoke('u-carol'); // revoked after the listing, before carol's item
            return ids.filter((i) => i !== 'u-carol' || calls < 2);
        });
        await svc.handleAction('bob', 'join', { channel: PAGE });
        await svc.handleAction('bob', 'send', { channel: PAGE, message: 'secret' });
        expect(inbox.rows.has('u-carol')).toBe(false);
        expect(inbox.rows.get('u-eve')).toHaveLength(1);
        expect(calls).toBeGreaterThan(2); // listing + one fresh ask per recipient
    });

    it('fails closed when the reader check throws', async () => {
        const { svc, inbox, receipts, currentReaders } = setup();
        await seedCursor(receipts, 'u-eve');
        currentReaders.mockRejectedValue(new Error('authority down') as never);
        await svc.postSystemMessage(PAGE, 'x');
        expect(inbox.rows.size).toBe(0);
    });

    it('skips users the host says are watching', async () => {
        const { svc, inbox, receipts } = setup({ unread: undefined });
        (svc as any).unread = { notify: inbox, itemId: (c: string) => `u:${c}`, describe: () => ({ title: 't' }), live: async () => new Set(['u-eve']) };
        await seedCursor(receipts, 'u-eve'); await seedCursor(receipts, 'u-carol');
        await svc.postSystemMessage(PAGE, 'x');
        expect([...inbox.rows.keys()]).toEqual(['u-carol']);
    });
});

describe('chat unread items: unread.channels filter (lane R5, 0.120.1)', () => {
    const DM = 'dm:u-bob:u-eve';
    const withFilter = (channels: (c: string) => boolean) => {
        const ctx = setup();
        const inbox = ctx.inbox;
        (ctx.svc as any).unread = { ...(ctx.svc as any).unread, notify: inbox, channels };
        const spy = jest.spyOn(ctx.receipts, 'listReceipts' as any);
        return { ...ctx, spy };
    };

    it('opted-out sends do no receipts read and make no item', async () => {
        const { svc, inbox, receipts, spy } = withFilter((c) => c.startsWith('page:'));
        await receipts.advance({ channel: DM, userId: 'u-eve', readAt: T0, updatedAt: T0 } as any);
        spy.mockClear();
        await svc.handleAction('bob', 'join', { channel: DM });
        await svc.handleAction('bob', 'send', { channel: DM, message: 'psst' });
        await svc.postSystemMessage(DM, 'sys');
        expect(spy).not.toHaveBeenCalled();
        expect(inbox.rows.size).toBe(0);
    });

    it('opted-in channels still create and clear items', async () => {
        const { svc, inbox, receipts, spy } = withFilter((c) => c.startsWith('page:'));
        await seedCursor(receipts, 'u-eve');
        await svc.handleAction('bob', 'join', { channel: PAGE });
        await svc.handleAction('bob', 'send', { channel: PAGE, message: 'hi' });
        expect(spy).toHaveBeenCalled(); // the spy does see receipts reads
        expect(inbox.rows.get('u-eve')).toHaveLength(1);
        await svc.handleAction('eve', 'read', { channel: PAGE });
        expect(inbox.rows.get('u-eve')![0].read).toBe(true);
    });
});
