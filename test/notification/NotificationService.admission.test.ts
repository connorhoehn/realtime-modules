// 0.118 (lane R5): replayOnConnect and read admission. An item reaches a user
// only if the host's `admit` says yes at delivery time (asked fresh, per
// record, per delivery) and the connection's principal is still current.
import { describe, it, expect, jest } from '@jest/globals';
import { NotificationService } from '../../src/notification/NotificationService';

class NoopLogger { info() {} warn() {} error() {} debug() {} }

function fakeStore() {
    const rows = new Map<string, any[]>();
    const read = new Map<string, Set<string>>();
    return {
        append: async (u: string, r: any) => { rows.set(u, [...(rows.get(u) ?? []), r]); },
        list: async (u: string) => (rows.get(u) ?? []).map((r) => (read.get(u)?.has(r.id) ? { ...r, read: true } : r)),
        listUnread: async (u: string) => (rows.get(u) ?? []).filter((r) => !read.get(u)?.has(r.id)),
        markRead: async (u: string, id: string) => { read.set(u, new Set([...(read.get(u) ?? []), id])); },
        markAllRead: async () => [],
    };
}

function setup(extra: Record<string, unknown> = {}) {
    const sent: any[] = [];
    const router: any = {
        sendToClient: jest.fn((clientId: string, frame: any) => { sent.push({ clientId, frame }); return true; }),
        getClientsByUserId: jest.fn(async (ids: string[]) => ids.includes('u-eve') ? [{ clientId: 'tab-1', userId: 'u-eve' }] : []),
        getUserIdForClient: (c: string) => (c === 'tab-1' || c === 'tab-2' ? 'u-eve' : null),
    };
    const svc = new NotificationService({ messageRouter: router, logger: new NoopLogger() as any, store: fakeStore() as any, ...extra } as any);
    return { svc, sent };
}
const bulks = (sent: any[], clientId: string) => sent.filter((s) => s.clientId === clientId && s.frame.type === 'notification:bulk-update');
const flush = () => new Promise((r) => setImmediate(r));

describe('NotificationService replayOnConnect + read admission', () => {
    it('replays the inbox once per connection on connect', async () => {
        const { svc, sent } = setup({ replayOnConnect: true });
        await svc.notifyUser('u-eve', { id: 'a', title: 'A', type: 'message' });
        sent.length = 0;
        await svc.onClientConnect('tab-2'); await svc.onClientConnect('tab-2'); await flush();
        expect(bulks(sent, 'tab-2')).toHaveLength(1);
        expect(bulks(sent, 'tab-2')[0].frame.payload.notifications.map((n: any) => n.id)).toEqual(['a']);
        // a reconnect (new connection id) is replayed again; the old one's slot is released
        await svc.onClientDisconnect('tab-2'); await svc.onClientConnect('tab-2'); await flush();
        expect(bulks(sent, 'tab-2')).toHaveLength(2);
    });

    it('does nothing on connect unless replayOnConnect is set', async () => {
        const { svc, sent } = setup();
        await svc.notifyUser('u-eve', { id: 'a', title: 'A', type: 'message' });
        sent.length = 0;
        await svc.onClientConnect('tab-2'); await flush();
        expect(bulks(sent, 'tab-2')).toHaveLength(0);
    });

    it('withholds from replay what read authority no longer admits, asking fresh each time', async () => {
        const allowed = new Set(['a', 'b']);
        const admit = jest.fn(async (_u: string, r: any) => allowed.has(r.id));
        const { svc, sent } = setup({ replayOnConnect: true, admit });
        await svc.notifyUser('u-eve', { id: 'a', title: 'A', type: 'message' });
        await svc.notifyUser('u-eve', { id: 'b', title: 'B', type: 'message' });
        allowed.delete('b'); // revoked between the post and the reconnect
        sent.length = 0;
        await svc.replayUnreadForUser('tab-2', 'u-eve');
        expect(bulks(sent, 'tab-2')[0].frame.payload.notifications.map((n: any) => n.id)).toEqual(['a']);
        allowed.delete('a');
        sent.length = 0;
        await svc.replayUnreadForUser('tab-2', 'u-eve');
        expect(sent).toEqual([]); // nothing admitted: no frame at all
        allowed.add('b'); // re-admitted: it is still stored, so it arrives
        await svc.replayUnreadForUser('tab-2', 'u-eve');
        expect(bulks(sent, 'tab-2')[0].frame.payload.notifications.map((n: any) => n.id)).toEqual(['b']);
    });

    it('does not deliver a live item to a user admission refuses, and fails closed on a throw', async () => {
        let verdict: boolean | 'throw' = false;
        const admit = jest.fn(async () => { if (verdict === 'throw') throw new Error('down'); return verdict; });
        const { svc, sent } = setup({ admit });
        const refused = await svc.notifyUser('u-eve', { id: 'x', title: 'X', type: 'message' });
        expect(refused.delivered).toBe(0);
        verdict = 'throw';
        expect((await svc.notifyUser('u-eve', { id: 'y', title: 'Y', type: 'message' })).delivered).toBe(0);
        verdict = true;
        expect((await svc.notifyUser('u-eve', { id: 'z', title: 'Z', type: 'message' })).delivered).toBe(1);
        expect(sent.filter((s) => s.frame.type === 'notification:new').map((s) => s.frame.payload.id)).toEqual(['z']);
    });

    it('refuses when the connection principal moves during admission (epoch bump mid-delivery)', async () => {
        let current = true;
        const principal = { recheckAfterIo: true, current: jest.fn(async () => current) };
        const admit = jest.fn(async () => { current = false; return true; }); // epoch bumps while the host decides
        const { svc, sent } = setup({ replayOnConnect: true, admit, principal });
        await svc.notifyUser('u-eve', { id: 'a', title: 'A', type: 'message' });
        expect(sent.filter((s) => s.frame.type === 'notification:new')).toEqual([]);
        current = true; sent.length = 0;
        await svc.replayUnreadForUser('tab-2', 'u-eve');
        expect(sent).toEqual([]);
    });
});
