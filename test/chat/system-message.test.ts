// realtime-modules/test/chat/system-message.test.ts
//
// Messages nobody typed.
//
// Something happens in a channel — a document is created in it, a call starts
// — and the thread is where people look for what happened. Every other send
// path starts from a clientId because every other message was typed by
// somebody; this one has no connection behind it.
//
// The property that matters most is that it is PERSISTED. An event only live
// viewers saw is not a record of anything, and the thread would disagree with
// itself on the next reload.

import { describe, it, expect, jest } from '@jest/globals';
const { ChatService } = require('../../dist/chat/ChatService');

class NoopLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

function makeService() {
    const broadcasts: any[] = [];
    const stored: any[] = [];
    const router: any = {
        sendToLocalClient: jest.fn(),
        sendToChannel: jest.fn(async (channel: string, message: any) => {
            broadcasts.push({ channel, message });
        }),
        subscribeToChannel: jest.fn(async () => {}),
        unsubscribeFromChannel: jest.fn(async () => {}),
        broadcastToAll: jest.fn(async () => {}),
    };
    const store = {
        putMessage: jest.fn(async (m: any) => { stored.push(m); }),
        listMessages: jest.fn(async () => []),
    };
    const service = new ChatService({
        messageRouter: router,
        logger: new NoopLogger() as any,
        chatStore: store,
    });
    return { service, broadcasts, stored, store };
}

describe('postSystemMessage', () => {
    it('persists it, so the thread still says so after a reload', async () => {
        const { service, stored } = makeService();
        await service.postSystemMessage('general', 'Bob created a document', {
            kind: 'document', documentId: 'd1',
        });
        expect(stored).toHaveLength(1);
        expect(stored[0].message).toBe('Bob created a document');
    });

    it('reaches the channel', async () => {
        const { service, broadcasts } = makeService();
        await service.postSystemMessage('general', 'x');
        expect(broadcasts).toHaveLength(1);
    });

    it('carries the caller metadata, which is what makes it a card', async () => {
        const { service, stored } = makeService();
        await service.postSystemMessage('general', 'x', { kind: 'document', documentId: 'd1' });
        expect(stored[0].metadata).toMatchObject({ kind: 'document', documentId: 'd1' });
    });

    // A renderer has to tell "the server said this" from "we lost the sender".
    it('marks itself as system', async () => {
        const { service, stored } = makeService();
        await service.postSystemMessage('general', 'x');
        expect(stored[0].metadata.system).toBe(true);
        expect(stored[0].clientId).toBe('system');
    });

    it('has no userId, because no user sent it', async () => {
        const { service, stored } = makeService();
        await service.postSystemMessage('general', 'x');
        expect(stored[0].userId).toBeUndefined();
    });

    it('refuses a message with no channel or no text', async () => {
        const { service, stored } = makeService();
        expect(await service.postSystemMessage('', 'x')).toBeNull();
        expect(await service.postSystemMessage('general', '')).toBeNull();
        expect(stored).toHaveLength(0);
    });

    // The message about a thing must never be able to break the thing.
    it('still broadcasts when persistence fails', async () => {
        const { service, broadcasts, store } = makeService();
        store.putMessage = jest.fn(async () => { throw new Error('table gone'); }) as any;
        await service.postSystemMessage('general', 'x');
        expect(broadcasts).toHaveLength(1);
    });
});
