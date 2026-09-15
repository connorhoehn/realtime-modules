// Typing is relayed, never stored, never echoed: the sender's own composer
// already knows, and history must not fill with "was typing" rows.
import { describe, it, expect, jest } from '@jest/globals';
import { ChatService } from '../../src/chat/ChatService';

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

describe('ChatService typing', () => {
    it('relays a joined client\'s typing to the channel, excluding the sender, with their identity', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const svc = new ChatService({
            messageRouter: router,
            logger: new NoopLogger() as any,
            identityResolver: () => ({ userId: 'u-carol', displayName: 'Carol' }),
        } as any);
        await svc.handleAction('c1', 'join', { channel: 'room:design' });
        sendToChannelCalls.length = 0;
        await svc.handleAction('c1', 'typing', { channel: 'room:design', typing: true });
        expect(sendToChannelCalls).toHaveLength(1);
        const call = sendToChannelCalls[0];
        expect(call.excludeClientId).toBe('c1');
        expect(call.message).toMatchObject({ type: 'chat', action: 'typing', channel: 'room:design', clientId: 'c1', userId: 'u-carol', displayName: 'Carol', typing: true });
    });

    it('refuses typing in a channel the client has not joined, and stores nothing either way', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const svc = new ChatService({ messageRouter: router, logger: new NoopLogger() as any } as any);
        await svc.handleAction('c9', 'typing', { channel: 'room:design', typing: true });
        expect(sendToChannelCalls).toHaveLength(0);
        expect(sentToClient.some((s) => /join the channel/.test(JSON.stringify(s.message)))).toBe(true);
    });
});
