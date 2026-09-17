// realtime-modules/test/chat/ChatService.sendPersistence.test.ts
//
// The send path used to ack `sent` and broadcast a message to every
// subscriber whether or not the store write behind it ever succeeded
// (`_persistMessage(...).catch(...)` was fire-and-forget). A store outage
// looked, to every participant, exactly like a successful send, and the
// message was gone on the next reload. This file pins the fix: a failing
// store must produce an error frame instead of `sent`, and must not
// broadcast; a healthy default (no store configured at all) must keep
// working exactly as before.

import { describe, it, expect, jest } from '@jest/globals';
import { ChatService } from '../../src/chat/ChatService';
import type { ChatStore } from '../../src/chat/ChatStore';
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

/** A store whose putMessage always rejects — simulates a store outage. */
class BrokenChatStore implements ChatStore {
    async putMessage(_message: ChatMessage): Promise<void> {
        throw new Error('write failed: store unreachable');
    }
    async listMessages(_channel: string, _limit: number): Promise<ChatMessage[]> {
        return [];
    }
    async updateMessage(_channel: string, _messageId: string, _patch: ChatMessagePatch): Promise<ChatMessage | null> {
        throw new Error('write failed: store unreachable');
    }
}

const errorsTo = (sent: any[], clientId: string) =>
    sent.filter((s) => s.clientId === clientId && s.message.type === 'error').map((s) => s.message);
const sentAcksTo = (sent: any[], clientId: string) =>
    sent.filter((s) => s.clientId === clientId && s.message.type === 'chat' && s.message.action === 'sent');

describe('ChatService send path — persistence must gate the ack', () => {
    it('a failing store does NOT produce a plain "sent" ack, and does NOT broadcast', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const chatStore = new BrokenChatStore();
        const svc = new ChatService({
            messageRouter: router,
            logger: new NoopLogger() as any,
            chatStore,
        } as any);

        await svc.handleAction('carol', 'join', { channel: 'general' });
        sentToClient.length = 0;

        await svc.handleAction('carol', 'send', { channel: 'general', message: 'will this survive?' });

        // No success ack of any kind reached the sender.
        expect(sentAcksTo(sentToClient, 'carol')).toEqual([]);

        // Instead, an explicit failure frame did.
        const errors = errorsTo(sentToClient, 'carol');
        expect(errors).toHaveLength(1);
        expect(errors[0].error).toMatchObject({ code: 'store-failed' });
        expect(errors[0].error.messageId).toEqual(expect.any(String));

        // Nobody else on the channel was told about a message that was
        // never durably written — the broadcast must not have happened.
        expect(sendToChannelCalls).toEqual([]);

        // The local cache must not disagree with the store: a client that
        // asks for history right after must not see a message the store
        // never got, or a reload would show something other clients never
        // received.
        const history = await svc.getChannelHistory('general', 10);
        expect(history).toEqual([]);
    });

    it('with no store configured at all (zero-config default), send still works end to end', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        // No `chatStore` in opts — ChatService falls back to its built-in
        // InMemoryChatStore. Persistence is "optional" in the sense that a
        // consumer need not wire one up; it must not become mandatory.
        const svc = new ChatService({
            messageRouter: router,
            logger: new NoopLogger() as any,
        } as any);

        await svc.handleAction('carol', 'join', { channel: 'general' });
        sentToClient.length = 0;

        await svc.handleAction('carol', 'send', { channel: 'general', message: 'hello world' });

        expect(errorsTo(sentToClient, 'carol')).toEqual([]);
        const acks = sentAcksTo(sentToClient, 'carol');
        expect(acks).toHaveLength(1);
        expect(acks[0].message).toMatchObject({
            type: 'chat',
            action: 'sent',
            channel: 'general',
        });
        expect(acks[0].message.messageId).toEqual(expect.any(String));
        expect(acks[0].message.timestamp).toEqual(expect.any(String));

        const broadcasts = sendToChannelCalls.filter((c) => c.message.action === 'message');
        expect(broadcasts).toHaveLength(1);
        expect(broadcasts[0].message.message).toMatchObject({ channel: 'general', message: 'hello world' });

        const history = await svc.getChannelHistory('general', 10);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ message: 'hello world' });
    });
});
