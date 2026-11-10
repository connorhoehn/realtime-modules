// realtime-modules/test/chat/ChatService.attachments.test.ts
//
// Attachments are named by id; the server writes the download URL. Before
// 0.146.0 the sender wrote `metadata.attachments[].url` and the server kept
// it, so a sender could point every viewer's token-carrying image fetch at a
// host of their choosing. A raw URL is now refused; a URL that is already the
// server-issued `/api/uploads/<id>` for that id is accepted (frames from
// older clients carry exactly that) and rewritten from the id either way.

import { describe, it, expect, jest } from '@jest/globals';
import { ChatService } from '../../src/chat/ChatService';

class NoopLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

function makeService(opts: Record<string, unknown> = {}) {
    const sent: any[] = [];
    const router: any = {
        sendToClient: jest.fn((_id: string, frame: any) => { sent.push(frame); }),
        checkChannel: () => true, // 0.147.0: services refuse a router without a channel check
        getClientData: ((ctx: Record<string, any>) => (id: string) => (ctx[id] ??= { userContext: { userId: `user-${id}` } }))({}), // 0.147.0: chat sends need an authenticated sender (one stable context per connection)
        sendToChannel: jest.fn(async () => {}),
        subscribeToChannel: jest.fn(async () => true),
        unsubscribeFromChannel: jest.fn(async () => {}),
    };
    const chatStore = {
        putMessage: jest.fn(async () => {}),
        listMessages: jest.fn(async () => []),
    };
    const service = new ChatService({ messageRouter: router, logger: new NoopLogger() as any, chatStore: chatStore as any, ...opts });
    service.clientChannels.addSubscription('c1', 'general');
    return { service, chatStore, sent, router };
}

const attachment = (over: Record<string, unknown> = {}) => ({
    id: 'tenant-a|0b6c1f4e-1111-2222-3333-444455556666',
    name: 'cat.png',
    size: 1234,
    contentType: 'image/png',
    ...over,
});

describe('chat attachments are ids; the server writes the URL', () => {
    it('rejects a send whose attachment carries a raw external URL', async () => {
        const { service, chatStore, sent, router } = makeService();
        await service.handleSendMessage('c1', {
            channel: 'general', message: 'look',
            metadata: { attachments: [attachment({ url: 'https://evil.example/x.png' })] },
        });
        expect(chatStore.putMessage).not.toHaveBeenCalled();
        expect(router.sendToChannel).not.toHaveBeenCalled();
        const err = sent.find((f) => f.type === 'error');
        expect(err?.error?.code).toBe('CHAT_BAD_ATTACHMENT');
    });

    it('rejects a server-shaped URL that names a different id', async () => {
        const { service, chatStore } = makeService();
        await service.handleSendMessage('c1', {
            channel: 'general', message: 'look',
            metadata: { attachments: [attachment({ url: '/api/uploads/someone-elses-id' })] },
        });
        expect(chatStore.putMessage).not.toHaveBeenCalled();
    });

    it('rejects an attachment with no id', async () => {
        const { service, chatStore } = makeService();
        await service.handleSendMessage('c1', {
            channel: 'general', message: '',
            metadata: { attachments: [{ name: 'x.png', url: '/api/uploads/x' }] },
        });
        expect(chatStore.putMessage).not.toHaveBeenCalled();
    });

    it('accepts an id-only attachment and stores the server-issued URL', async () => {
        const { service, chatStore } = makeService();
        await service.handleSendMessage('c1', { channel: 'general', message: '', metadata: { attachments: [attachment()] } });
        const stored = (chatStore.putMessage.mock.calls[0] as any[])[0];
        expect(stored.metadata.attachments[0].url)
            .toBe(`/api/uploads/${encodeURIComponent('tenant-a|0b6c1f4e-1111-2222-3333-444455556666')}`);
    });

    it('accepts an older frame that already carries the server-issued URL', async () => {
        const id = attachment().id;
        const { service, chatStore } = makeService();
        await service.handleSendMessage('c1', {
            channel: 'general', message: 'hi',
            metadata: { attachments: [attachment({ url: `/api/uploads/${encodeURIComponent(id)}` })] },
        });
        expect(chatStore.putMessage).toHaveBeenCalledTimes(1);
    });

    it('builds the URL with the host-supplied attachmentUrlFor', async () => {
        const { service, chatStore } = makeService({ attachmentUrlFor: (id: string) => `https://gw.example/api/uploads/${id}` });
        await service.handleSendMessage('c1', {
            channel: 'general', message: 'hi',
            metadata: { attachments: [attachment({ id: 'abc', url: 'https://gw.example/api/uploads/abc' })] },
        });
        const stored = (chatStore.putMessage.mock.calls[0] as any[])[0];
        expect(stored.metadata.attachments[0].url).toBe('https://gw.example/api/uploads/abc');
    });

    it('drops a preview that is not an inline data image', async () => {
        const { service, chatStore } = makeService();
        await service.handleSendMessage('c1', {
            channel: 'general', message: 'hi',
            metadata: { attachments: [attachment({ preview: 'https://evil.example/pixel.gif' })] },
        });
        const stored = (chatStore.putMessage.mock.calls[0] as any[])[0];
        expect(stored.metadata.attachments[0].preview).toBeUndefined();
    });

    it('rejects an edit that swaps in a raw URL', async () => {
        const { service, chatStore, sent } = makeService({ identityResolver: () => ({ userId: 'u1' }) });
        await service.handleSendMessage('c1', { channel: 'general', message: 'hi', metadata: { attachments: [attachment()] } });
        const stored = (chatStore.putMessage.mock.calls[0] as any[])[0];
        sent.length = 0;
        await service.handleEditMessage('c1', {
            channel: 'general', messageId: stored.id, message: 'edited',
            metadata: { attachments: [attachment({ url: 'https://evil.example/x.png' })] },
        });
        expect(sent.find((f) => f.type === 'error')?.error?.code).toBe('CHAT_BAD_ATTACHMENT');
    });
});
