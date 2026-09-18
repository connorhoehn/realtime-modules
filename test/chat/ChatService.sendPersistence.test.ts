// realtime-modules/test/chat/ChatService.sendPersistence.test.ts
//
// The send path used to ack `sent` and broadcast a message to every
// subscriber whether or not the store write behind it ever succeeded
// (`_persistMessage(...).catch(...)` was fire-and-forget). A store outage
// looked, to every participant, exactly like a successful send, and the
// message was gone on the next reload. This file pins the fix: a failing
// store must produce an error frame instead of `sent`.
//
// It must STILL BROADCAST, though. The gateway states "a store outage does
// not drop live chat" as a deliberate property, with its own integration test
// calling it load-bearing — realtime delivery is the product and history is
// what degrades. The two properties only looked contradictory because
// persistence, delivery and the ack were one step: separate them and the
// message is delivered live while the SENDER is told it was not stored.
//
// A healthy default (no store configured at all) must keep working as before.

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
    it('a failing store does NOT produce a plain "sent" ack, but DOES still deliver live', async () => {
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

        // But the channel DID receive it. "A store outage does not drop live
        // chat" is a deliberate gateway property; what was wrong before was
        // telling the sender it had been stored, not the delivery itself.
        expect(sendToChannelCalls).toHaveLength(1);

        // And it is in the in-process cache, so clients connected right now
        // can still read it back. It is the DURABLE copy that is missing —
        // which is exactly what the sender was just told.
        const history = await svc.getChannelHistory('general', 10);
        expect(history).toHaveLength(1);
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
