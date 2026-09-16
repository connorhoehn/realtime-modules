import { describe, it, expect, jest } from '@jest/globals';
import { ChatService } from '../../src/chat/ChatService';
import { InMemoryChatStore } from '../../src/chat/ChatStore';

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
};

function makeService(router: any) {
    const chatStore = new InMemoryChatStore();
    const changes: any[] = [];
    const svc = new ChatService({
        messageRouter: router,
        logger: new NoopLogger() as any,
        chatStore,
        identityResolver: (clientId: string) => IDS[clientId] ?? null,
        onMessageChanged: (info: any) => changes.push(info),
    } as any);
    return { svc, chatStore, changes };
}

const errorsTo = (sent: any[], clientId: string) => sent.filter((s) => s.clientId === clientId && s.message.type === 'error').map((s) => s.message);
const frames = (calls: any[], action: string) => calls.filter((c) => c.message.action === action).map((c) => c.message);

async function postOne(svc: ChatService, router: any, calls: any[]): Promise<string> {
    await svc.handleAction('carol', 'join', { channel: 'general' });
    await svc.handleAction('eve', 'join', { channel: 'general' });
    await svc.handleAction('carol', 'send', { channel: 'general', message: 'first draft', metadata: { mentions: ['u-eve'] } });
    const posted = frames(calls, 'message')[0];
    calls.length = 0;
    return posted.message.id as string;
}

describe('ChatService edit', () => {
    it('lets the author change the text, stamps editedAt, merges metadata, and tells the channel', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc, chatStore, changes } = makeService(router);
        const id = await postOne(svc, router, sendToChannelCalls);

        await svc.handleAction('carol', 'edit', { channel: 'general', messageId: id, message: 'second draft', metadata: { html: '<p>second draft</p>' } });
        expect(errorsTo(sentToClient, 'carol')).toEqual([]);
        const updated = frames(sendToChannelCalls, 'messageUpdated');
        expect(updated).toHaveLength(1);
        expect(updated[0]).toMatchObject({ type: 'chat', channel: 'general', message: { id, message: 'second draft', userId: 'u-carol' } });
        expect(updated[0].message.editedAt).toEqual(expect.any(String));
        expect(updated[0].message.metadata).toMatchObject({ mentions: ['u-eve'], html: '<p>second draft</p>' });
        // The publisher is named so the router runs authz; the sender still gets the echo.
        expect(sendToChannelCalls[0].opts).toEqual({ publisherClientId: 'carol' });

        // History reflects it, from the cache and from the store.
        const history = await svc.getChannelHistory('general', 10);
        expect(history[0]).toMatchObject({ id, message: 'second draft', editedAt: updated[0].message.editedAt });
        const stored = await chatStore.listMessages('general', 10);
        expect(stored[0]).toMatchObject({ id, message: 'second draft', editedAt: updated[0].message.editedAt });
        expect(changes[0]).toMatchObject({ channel: 'general', kind: 'edited', message: { id, message: 'second draft' } });
    });

    it('refuses anyone but the author, an unknown message, and an empty edit', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc } = makeService(router);
        const id = await postOne(svc, router, sendToChannelCalls);

        await svc.handleAction('eve', 'edit', { channel: 'general', messageId: id, message: 'not mine' });
        expect(errorsTo(sentToClient, 'eve')[0].error.code).toBe('forbidden');
        await svc.handleAction('carol', 'edit', { channel: 'general', messageId: 'nope', message: 'x' });
        expect(errorsTo(sentToClient, 'carol')[0].error.code).toBe('not-found');
        await svc.handleAction('carol', 'edit', { channel: 'general', messageId: id, message: '' });
        expect(errorsTo(sentToClient, 'carol')[1].error.code).toBe('bad-request');
        expect(frames(sendToChannelCalls, 'messageUpdated')).toHaveLength(0);
    });
});

describe('ChatService delete', () => {
    it('soft-deletes for the author, tells the channel, and refuses a later edit', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc, chatStore, changes } = makeService(router);
        const id = await postOne(svc, router, sendToChannelCalls);

        await svc.handleAction('carol', 'delete', { channel: 'general', messageId: id });
        expect(errorsTo(sentToClient, 'carol')).toEqual([]);
        const deleted = frames(sendToChannelCalls, 'messageDeleted');
        expect(deleted).toHaveLength(1);
        expect(deleted[0]).toMatchObject({ type: 'chat', channel: 'general', messageId: id });
        expect(deleted[0].deletedAt).toEqual(expect.any(String));

        const history = await svc.getChannelHistory('general', 10);
        expect(history[0]).toMatchObject({ id, message: '', metadata: { deleted: true }, deletedAt: deleted[0].deletedAt, userId: 'u-carol' });
        const stored = await chatStore.listMessages('general', 10);
        expect(stored[0]).toMatchObject({ id, message: '', metadata: { deleted: true } });
        expect(changes[0]).toMatchObject({ kind: 'deleted', message: { id } });

        await svc.handleAction('carol', 'edit', { channel: 'general', messageId: id, message: 'too late' });
        expect(errorsTo(sentToClient, 'carol')[0].error.code).toBe('gone');
    });

    it('refuses a non-author', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const { svc } = makeService(router);
        const id = await postOne(svc, router, sendToChannelCalls);
        await svc.handleAction('eve', 'delete', { channel: 'general', messageId: id });
        expect(errorsTo(sentToClient, 'eve')[0].error.code).toBe('forbidden');
        expect(frames(sendToChannelCalls, 'messageDeleted')).toHaveLength(0);
    });
});

describe('InMemoryChatStore.updateMessage', () => {
    it('patches in place and answers null for an unknown id', async () => {
        const store = new InMemoryChatStore();
        await store.putMessage({ id: 'm1', clientId: 'c', channel: 'ch', message: 'a', metadata: { x: 1 }, timestamp: 't' });
        const out = await store.updateMessage('ch', 'm1', { message: 'b', editedAt: 'e' });
        expect(out).toMatchObject({ id: 'm1', message: 'b', editedAt: 'e', metadata: { x: 1 } });
        expect((await store.listMessages('ch', 5))[0]).toMatchObject({ message: 'b', editedAt: 'e' });
        expect(await store.updateMessage('ch', 'zzz', { message: 'b' })).toBeNull();
    });
});
