import { describe, it, expect } from '@jest/globals';
import { MemoryChatMembershipStore, memberView } from '../../src/chat/ChatMembershipStore';

describe('MemoryChatMembershipStore', () => {
    it('upserts on (channel, userId), lists per channel, and hands out copies', async () => {
        const store = new MemoryChatMembershipStore();
        const row = { channel: 'room:a', userId: 'u1', role: 'owner' as const, addedBy: 'u1', addedAt: 't0', historyFrom: null, removedAt: null };
        await store.putMember(row);
        await store.putMember({ ...row, userId: 'u2', role: 'member', historyFrom: 't1' });
        await store.putMember({ ...row, userId: 'u2', role: 'member', historyFrom: 't2' });
        expect(await store.listMembers('room:b')).toEqual([]);
        const rows = await store.listMembers('room:a');
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.userId === 'u2')!.historyFrom).toBe('t2');
        const got = (await store.getMember('room:a', 'u1'))!;
        got.role = 'member';
        expect((await store.getMember('room:a', 'u1'))!.role).toBe('owner');
        expect(memberView(row)).toEqual({ userId: 'u1', role: 'owner', addedBy: 'u1', addedAt: 't0', historyFrom: null });
    });
});
