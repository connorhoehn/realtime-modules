// realtime-modules/test/chat/metadata-budget.test.ts
//
// What happens to a message whose metadata does not fit the budget.
//
// Attachments ride in `metadata.attachments`, and each image attachment
// carries a base64 `preview` — a 32px thumbnail from
// `canvas.toDataURL('image/jpeg', 0.5)`, measured at 1124–1376 characters for
// real images. Three of them clear the 4096-byte default cap on their own.
//
// The old overflow path returned `{ _truncated: true, displayName }` — it
// threw away EVERYTHING. The message still posted, so the sender saw their
// text appear and their three files simply cease to exist, along with any
// @mentions and the reply they were answering. Nothing surfaced, because from
// the client's point of view the send succeeded.
//
// Shedding the biggest keys is the difference between losing the attachments
// and losing the whole message envelope.

import { describe, it, expect, jest } from '@jest/globals';
const { ChatService } = require('../../dist/chat/ChatService');

class NoopLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

function makeService() {
    const router: any = {
        sendToLocalClient: jest.fn(),
        sendToClient: jest.fn(),
        sendToChannel: jest.fn(async () => {}),
        subscribeToChannel: jest.fn(async () => {}),
        unsubscribeFromChannel: jest.fn(async () => {}),
        broadcastToAll: jest.fn(async () => {}),
    };
    const chatStore = {
        putMessage: jest.fn(async () => {}),
        listMessages: jest.fn(async () => []),
    };
    const service = new ChatService({
        messageRouter: router,
        logger: new NoopLogger() as any,
        chatStore,
    });
    return { service, chatStore };
}

/** A base64 preview the size the real composer produces. */
const preview = () => `data:image/jpeg;base64,${'A'.repeat(1200)}`;
const attachment = (n: number) => ({
    id: `11111111-2222-3333-4444-00000000000${n}`,
    name: `screenshot-${n}.png`,
    size: 482_113,
    contentType: 'image/png',
    url: `http://localhost:3000/files/download/transfer-${n}`,
    width: 1024,
    height: 768,
    preview: preview(),
});

async function sentMetadata(metadata: Record<string, unknown>) {
    const { service, chatStore } = makeService();
    service.clientChannels.addSubscription('c1', 'general');
    await service.handleSendMessage('c1', { channel: 'general', message: 'here you go', metadata });
    return (chatStore.putMessage.mock.calls[0] as any[])[0].metadata;
}

describe('metadata that does not fit the budget', () => {
    it('keeps everything when it fits', async () => {
        const meta = await sentMetadata({ mentions: ['alice'], attachments: [attachment(1)] });
        expect(meta.attachments).toHaveLength(1);
        expect(meta.mentions).toEqual(['alice']);
        expect(meta._truncated).toBeUndefined();
    });

    // The whole point. Three previews are ~4.2KB, over the 4096 default.
    it('sheds the biggest key instead of the whole envelope', async () => {
        const meta = await sentMetadata({
            mentions: ['alice', 'bob'],
            replyTo: { messageId: 'm-42', author: 'alice' },
            attachments: [attachment(1), attachment(2), attachment(3)],
        });

        // What used to survive: nothing but displayName.
        expect(meta.mentions).toEqual(['alice', 'bob']);
        expect(meta.replyTo).toEqual({ messageId: 'm-42', author: 'alice' });
    });

    it('says what it dropped, so the client can stop pretending it sent', async () => {
        const meta = await sentMetadata({
            mentions: ['alice'],
            attachments: [attachment(1), attachment(2), attachment(3)],
        });
        expect(meta._truncated).toBe(true);
        expect(meta._droppedKeys).toContain('attachments');
    });

    it('actually fits the budget afterwards', async () => {
        const meta = await sentMetadata({
            mentions: ['alice'],
            html: '<p>'.repeat(400),
            attachments: [attachment(1), attachment(2), attachment(3)],
        });
        expect(JSON.stringify(meta).length).toBeLessThanOrEqual(4096);
    });
});
