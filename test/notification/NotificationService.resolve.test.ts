// 0.147: resolve(userId, key) — an answered need disappears from every open
// inbox: removed from the store, `notification:resolved` to every live tab.
import { describe, it, expect, jest } from '@jest/globals';
import { NotificationService } from '../../src/notification/NotificationService';
import { InMemoryNotificationStore } from '../../src/notification';

class NoopLogger { info() {} warn() {} error() {} debug() {} }

function harness(store: any) {
    const sent: Array<{ clientId: string; frame: any }> = [];
    const router: any = {
        sendToClient: jest.fn((clientId: string, frame: any) => { sent.push({ clientId, frame }); return true; }),
        getClientsByUserId: jest.fn(async (ids: string[]) => (ids.includes('u-me')
            ? [{ clientId: 'tab-1', userId: 'u-me' }, { clientId: 'tab-2', userId: 'u-me' }] : [])),
        getUserIdForClient: (clientId: string) => (clientId.startsWith('tab-') || clientId === 'tab-new' ? 'u-me' : null),
    };
    const svc = new NotificationService({ messageRouter: router, logger: new NoopLogger() as any, store, insecureAllowAll: true });
    return { svc, sent };
}

describe('NotificationService.resolve (0.147)', () => {
    it('removes the need from the in-memory store and tells every tab', async () => {
        const store = new InMemoryNotificationStore();
        const { svc, sent } = harness(store);
        await svc.notifyUser('u-me', { id: 'need:approve-mina', type: 'approval-requested', title: 'Approve Mina' });
        await svc.notifyUser('u-me', { id: 'need:draw-toby', type: 'approval-requested', title: 'Draw Toby' });
        sent.length = 0;

        expect(await svc.resolve('u-me', 'need:approve-mina')).toEqual({ removed: true, delivered: 2 });
        expect(sent.map((s) => [s.clientId, s.frame])).toEqual([
            ['tab-1', { type: 'notification:resolved', service: 'notification', payload: { id: 'need:approve-mina' } }],
            ['tab-2', { type: 'notification:resolved', service: 'notification', payload: { id: 'need:approve-mina' } }],
        ]);
        expect((await svc.listForUser('u-me')).map((n) => n.id)).toEqual(['need:draw-toby']);

        // A new tab's replay no longer carries it.
        sent.length = 0;
        await svc.replayUnreadForUser('tab-new', 'u-me');
        expect(sent[0].frame.payload.notifications.map((n: any) => n.id)).toEqual(['need:draw-toby']);

        // Idempotent: a second resolve still tells tabs, but removes nothing.
        expect(await svc.resolve('u-me', 'need:approve-mina')).toEqual({ removed: false, delivered: 2 });
        expect(await svc.resolveMany('u-me', ['need:draw-toby', 'need:draw-toby', ''])).toEqual({ removed: 1, delivered: 2 });
        expect(await svc.listForUser('u-me')).toEqual([]);
    });

    it('marks the record read on a store without remove, so it is not replayed', async () => {
        const rows: any[] = [];
        const read = new Set<string>();
        const store = {
            append: async (_u: string, r: any) => { rows.push(r); },
            list: async () => rows.map((r) => (read.has(r.id) ? { ...r, read: true } : r)),
            listUnread: async () => rows.filter((r) => !read.has(r.id)),
            markRead: async (_u: string, id: string) => { read.add(id); },
            markAllRead: async () => [],
        };
        const { svc } = harness(store);
        await svc.notifyUser('u-me', { id: 'k', type: 'system', title: 'T' });
        expect(await svc.resolve('u-me', 'k')).toEqual({ removed: false, delivered: 2 });
        expect(await store.listUnread()).toEqual([]);
    });

    it('still tells tabs when the store fails, and rejects a missing user or key', async () => {
        const store = { append: async () => {}, list: async () => [], listUnread: async () => [], markRead: async () => {}, markAllRead: async () => [], remove: async () => { throw new Error('boom'); } };
        const { svc } = harness(store);
        expect(await svc.resolve('u-me', 'k')).toEqual({ removed: false, delivered: 2 });
        await expect(svc.resolve('', 'k')).rejects.toThrow(/userId/);
        await expect(svc.resolve('u-me', '')).rejects.toThrow(/key/);
    });
});
