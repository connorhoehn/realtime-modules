import { createRowsChatBackend, TestIdentityDirectory, FakeClusterRedis } from '../../src/testing';
import type { ChatMessage } from '../../src/chat';

const msg = (id: string, channel = 'c', ts = '2026-01-01T00:00:0' + id + 'Z'): ChatMessage =>
    ({ id, channel, clientId: 'x', message: id, timestamp: ts } as ChatMessage);

describe('@connorhoehn/realtime-modules/testing', () => {
    it('rows chat backend reads through the getter and copies in and out', async () => {
        const rows: ChatMessage[] = [];
        const b = createRowsChatBackend({ messages: () => rows });
        const m = msg('1');
        await b.chatStore.putMessage(m);
        m.message = 'mutated';
        expect(rows[0]!.message).toBe('1');
        await b.chatStore.putMessage(msg('2'));
        expect((await b.chatStore.listMessages('c', 1)).map(x => x.id)).toEqual(['2']);
        await b.chatStore.updateMessage('c', '1', { message: 'edited' } as never);
        expect((await b.chatStore.getMessage('c', '1'))?.message).toBe('edited');
        rows.length = 0; // a fixture reset takes every message back
        expect(await b.chatStore.listMessages('c', 10)).toEqual([]);
    });

    it('read receipts only move forward', async () => {
        const b = createRowsChatBackend();
        expect(await b.readReceiptStore.advance({ channel: 'c', userId: 'u', readAt: '2', messageId: 'b' } as never)).not.toBeNull();
        expect(await b.readReceiptStore.advance({ channel: 'c', userId: 'u', readAt: '1', messageId: 'a' } as never)).toBeNull();
    });

    it('a switch on one clone revokes nothing else', () => {
        let now = 1000;
        const dir = new TestIdentityDirectory({ personas: { vera: { grants: { orgiq: ['member'] } } }, now: () => now, ttlMs: 100 });
        const a = dir.clone('vera'), b = dir.clone('vera');
        const principal = dir.principal();
        const ctxA = dir.context(a.id), ctxB = dir.context(b.id);
        expect(principal.revalidate(ctxA)).toBe(true);
        dir.switchContext(a.id, { social: ['participant'] });
        expect(principal.revalidate(ctxA)).toBe(false);
        expect(principal.revalidate(ctxB)).toBe(true);
        now += 101;
        expect(dir.get(b.id)).toBeNull();
        expect(principal.revalidate(ctxB)).toBe(false);
    });

    it('the fake redis stalls a reply after committing the write', async () => {
        const redis = new FakeClusterRedis();
        const held = redis.hold(args => args[0] === 'SET');
        let done = false;
        const p = redis.command('SET', 'k', 'v').then(() => { done = true; });
        await held.reached;
        expect(redis.get('k')).toBe('v');
        expect(done).toBe(false);
        held.release();
        await p;
        expect(done).toBe(true);
    });
});
