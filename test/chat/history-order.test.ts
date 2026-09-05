// realtime-modules/test/chat/history-order.test.ts
//
// The order and the SLICE of channel history.
//
// `getChannelHistory` served its warm path from an LRU cache, and
// `lru-cache`'s `values()` iterates most-recently-used FIRST. Two bugs came
// out of that one line:
//
//   1. every transcript rendered newest-message-first, so a conversation read
//      backwards, and
//   2. `.slice(-limit)` took the OLDEST messages instead of the newest —
//      asking a 100-message channel for its last 20 returned its first 20.
//
// The second is the one that hides: a short channel looks fine because every
// message fits, and the bug only appears once a conversation outgrows the
// limit — by which time the missing messages look like they were never sent.

import { describe, it, expect, jest } from '@jest/globals';
const { ChatService } = require('../../dist/chat/ChatService');

class NoopLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

function makeService(stored: any[] = []) {
    const router: any = {
        sendToLocalClient: jest.fn(),
        sendToChannel: jest.fn(async () => {}),
        subscribeToChannel: jest.fn(async () => {}),
        unsubscribeFromChannel: jest.fn(async () => {}),
        broadcastToAll: jest.fn(async () => {}),
    };
    const chatStore = {
        putMessage: jest.fn(async () => {}),
        // Contract: the store returns CHRONOLOGICAL (oldest first).
        listMessages: jest.fn(async (_c: string, limit: number) => stored.slice(-limit)),
    };
    return new ChatService({ messageRouter: router, logger: new NoopLogger() as any, chatStore });
}

const msg = (n: number) => ({
    id: `m${String(n).padStart(3, '0')}`,
    clientId: 'c1',
    channel: 'general',
    message: `message ${n}`,
    metadata: {},
    timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(),
});

const texts = (list: any[]) => list.map((m) => m.message);

describe('history read from the store', () => {
    it('is chronological, oldest first', async () => {
        const service = makeService([msg(1), msg(2), msg(3)]);
        expect(texts(await service.getChannelHistory('general', 10)))
            .toEqual(['message 1', 'message 2', 'message 3']);
    });
});

describe('history read from the warm cache', () => {
    // The cache is populated by the read above, and by every live send.
    it('is still chronological on the second read', async () => {
        const service = makeService([msg(1), msg(2), msg(3)]);
        await service.getChannelHistory('general', 10);
        expect(texts(await service.getChannelHistory('general', 10)))
            .toEqual(['message 1', 'message 2', 'message 3']);
    });

    it('is chronological after live messages arrive', async () => {
        const service = makeService([]);
        for (const n of [1, 2, 3]) service.addToChannelHistory('general', msg(n));
        expect(texts(await service.getChannelHistory('general', 10)))
            .toEqual(['message 1', 'message 2', 'message 3']);
    });

    // The bug that hides until a conversation outgrows its limit: the missing
    // messages look like they were never sent.
    it('returns the NEWEST n when the channel is longer than the limit', async () => {
        const service = makeService([]);
        for (let n = 1; n <= 10; n += 1) service.addToChannelHistory('general', msg(n));
        expect(texts(await service.getChannelHistory('general', 3)))
            .toEqual(['message 8', 'message 9', 'message 10']);
    });

    it('does not truncate a channel shorter than the limit', async () => {
        const service = makeService([]);
        for (const n of [1, 2]) service.addToChannelHistory('general', msg(n));
        expect(texts(await service.getChannelHistory('general', 50))).toHaveLength(2);
    });
});

describe('what a joiner is sent', () => {
    it('gets the newest slice, in reading order', async () => {
        const service = makeService([]);
        for (let n = 1; n <= 8; n += 1) service.addToChannelHistory('general', msg(n));
        service.joinHistoryLimit = 3;

        const sent: any[] = [];
        service.sendToClient = (_id: string, frame: any) => sent.push(frame);
        await service.sendChannelHistory('c1', 'general');

        expect(texts(sent[0].messages)).toEqual(['message 6', 'message 7', 'message 8']);
    });
});
