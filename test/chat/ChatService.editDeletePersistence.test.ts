// realtime-modules/test/chat/ChatService.editDeletePersistence.test.ts
//
// `_applyMessagePatch` used to write to `chatStore.updateMessage` inside a
// try/catch that only logged, and both its callers (`handleEditMessage`,
// `handleDeleteMessage`) then broadcast `messageUpdated` / `messageDeleted`
// unconditionally — so an edit or delete that never reached the store was
// still announced to everyone as though it happened, and reverted on the
// next reload. This pins the fix: the store write is awaited and must
// succeed before the broadcast; on failure the actor gets a `store-failed`
// error frame and nobody is told anything changed.

import { describe, it, expect, jest } from '@jest/globals';
import { ChatService } from '../../src/chat/ChatService';
import { InMemoryChatStore } from '../../src/chat/ChatStore';
import type { ChatMessage, ChatMessagePatch } from '../../src/chat/types';

class NoopLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

function makeRouter() {
    const sentToClient: any[] = [];
    const sendToChannelCalls: any[] = [];
    const router: any = {
        redisAvailable: false,
        sendToClient: jest.fn((clientId: string, message: any) => {
            sentToClient.push({ clientId, message });
        }),
        sendToChannel: jest.fn(async (channel: string, message: any, excludeClientId?: string | null, opts?: any) => {
            sendToChannelCalls.push({ channel, message, excludeClientId, opts });
        }),
        subscribeToChannel: jest.fn(async () => true),
        unsubscribeFromChannel: jest.fn(async () => undefined),
    };
    return { router, sentToClient, sendToChannelCalls };
}

/**
 * Puts succeed (so an initial send works normally) but every
 * `updateMessage` — the edit/delete write path — rejects, simulating a
 * store outage that only shows up once a message already exists.
 */
class BrokenUpdateChatStore extends InMemoryChatStore {
    async updateMessage(_channel: string, _messageId: string, _patch: ChatMessagePatch): Promise<ChatMessage | null> {
        throw new Error('write failed: store unreachable');
    }
}

const errorsTo = (sent: any[], clientId: string) =>
    sent.filter((s) => s.clientId === clientId && s.message.type === 'error').map((s) => s.message);

async function setupWithMessage(chatStore: InMemoryChatStore) {
    const { router, sentToClient, sendToChannelCalls } = makeRouter();
    const svc = new ChatService({
        messageRouter: router,
        logger: new NoopLogger() as any,
        chatStore,
        identityResolver: (clientId: string) => ({ userId: clientId }),
    } as any);

    await svc.handleAction('carol', 'join', { channel: 'general' });
    await svc.handleAction('carol', 'send', { channel: 'general', message: 'original text' });
    const history = await svc.getChannelHistory('general', 10);
    const messageId = history[0].id;
    sentToClient.length = 0;
    sendToChannelCalls.length = 0;
    return { svc, router, sentToClient, sendToChannelCalls, messageId };
}

describe('ChatService edit/delete path — persistence must gate the broadcast', () => {
    it('a failing store on edit does NOT broadcast messageUpdated, and the sender gets store-failed', async () => {
        const { svc, sentToClient, sendToChannelCalls, messageId } = await setupWithMessage(
            new BrokenUpdateChatStore()
        );

        await svc.handleAction('carol', 'edit', { channel: 'general', messageId, message: 'edited text' });

        const errors = errorsTo(sentToClient, 'carol');
        expect(errors).toHaveLength(1);
        expect(errors[0].error).toMatchObject({ code: 'store-failed' });

        // Nobody was told the message changed.
        const updates = sendToChannelCalls.filter((c) => c.message.action === 'messageUpdated');
        expect(updates).toEqual([]);

        // The local cache/history must not disagree with the store: a
        // reload must still show the original text, not the failed edit.
        const history = await svc.getChannelHistory('general', 10);
        expect(history[0]).toMatchObject({ message: 'original text' });
    });

    it('a failing store on delete does NOT broadcast messageDeleted, and the sender gets store-failed', async () => {
        const { svc, sentToClient, sendToChannelCalls, messageId } = await setupWithMessage(
            new BrokenUpdateChatStore()
        );

        await svc.handleAction('carol', 'delete', { channel: 'general', messageId });

        const errors = errorsTo(sentToClient, 'carol');
        expect(errors).toHaveLength(1);
        expect(errors[0].error).toMatchObject({ code: 'store-failed' });

        // Nobody was told the message was deleted — the worst case: a
        // person believing they removed something that is still there.
        const deletions = sendToChannelCalls.filter((c) => c.message.action === 'messageDeleted');
        expect(deletions).toEqual([]);

        // The message is still there, undeleted, on reload.
        const history = await svc.getChannelHistory('general', 10);
        expect(history[0]).toMatchObject({ message: 'original text' });
        expect(history[0].deletedAt).toBeUndefined();
    });

    it('with a healthy store, edit and delete still work end to end', async () => {
        const { svc, sentToClient, sendToChannelCalls, messageId } = await setupWithMessage(new InMemoryChatStore());

        await svc.handleAction('carol', 'edit', { channel: 'general', messageId, message: 'edited text' });
        expect(errorsTo(sentToClient, 'carol')).toEqual([]);
        expect(sendToChannelCalls.filter((c) => c.message.action === 'messageUpdated')).toHaveLength(1);
        let history = await svc.getChannelHistory('general', 10);
        expect(history[0]).toMatchObject({ message: 'edited text' });

        sentToClient.length = 0;
        sendToChannelCalls.length = 0;

        await svc.handleAction('carol', 'delete', { channel: 'general', messageId });
        expect(errorsTo(sentToClient, 'carol')).toEqual([]);
        expect(sendToChannelCalls.filter((c) => c.message.action === 'messageDeleted')).toHaveLength(1);
        history = await svc.getChannelHistory('general', 10);
        expect(history[0].deletedAt).toEqual(expect.any(String));
    });
});
