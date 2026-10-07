// 0.115: the host reads a user's inbox and marks items read server-side
// (an unread-thread item cleared once the thread is read), echoing
// `notification:read` to every live tab exactly like a tab's own markRead.
import { describe, it, expect, jest } from '@jest/globals';
import { NotificationService } from '../../src/notification/NotificationService';

class NoopLogger { info() {} warn() {} error() {} debug() {} }

function fakeStore() {
    const rows = new Map<string, any[]>();
    const read = new Map<string, Set<string>>();
    return {
        append: async (userId: string, record: any) => { rows.set(userId, [...(rows.get(userId) ?? []), record]); },
        list: async (userId: string) => (rows.get(userId) ?? []).map((r) => (read.get(userId)?.has(r.id) ? { ...r, read: true } : r)),
        listUnread: async (userId: string) => (rows.get(userId) ?? []).filter((r) => !read.get(userId)?.has(r.id)),
        markRead: async (userId: string, id: string) => { read.set(userId, new Set([...(read.get(userId) ?? []), id])); },
        markAllRead: async () => [],
    };
}

describe('NotificationService server-side read', () => {
    it('lists a user\'s inbox and marks ids read, echoing to every tab', async () => {
        const sent: any[] = [];
        const router: any = {
            sendToClient: jest.fn((clientId: string, frame: any) => { sent.push({ clientId, frame }); return true; }),
            getClientsByUserId: jest.fn(async (ids: string[]) => ids.includes('u-eve') ? [{ clientId: 'tab-1', userId: 'u-eve' }, { clientId: 'tab-2', userId: 'u-eve' }] : []),
        };
        const svc = new NotificationService({ messageRouter: router, logger: new NoopLogger() as any, store: fakeStore() as any });
        await svc.notifyUser('u-eve', { id: 'unread:a', title: 'New messages', type: 'message' });
        await svc.notifyUser('u-eve', { id: 'other', title: 'Something else', type: 'system' });
        expect((await svc.listForUser('u-eve')).map((n) => n.id)).toEqual(['unread:a', 'other']);
        sent.length = 0;

        await svc.markReadForUser('u-eve', ['unread:a', 'unread:a', '']);
        const reads = sent.filter((s) => s.frame.type === 'notification:read');
        expect(reads.map((s) => [s.clientId, s.frame.payload.id])).toEqual([['tab-1', 'unread:a'], ['tab-2', 'unread:a']]);
        expect((await svc.listForUser('u-eve')).map((n) => [n.id, !!n.read])).toEqual([['unread:a', true], ['other', false]]);
        expect(await svc.listForUser('')).toEqual([]);
    });
});
