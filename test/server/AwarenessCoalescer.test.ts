// realtime-modules/test/server/AwarenessCoalescer.test.ts
//
// Lifted from gateway test/crdt-awareness-coalescer.test.js.
// Import path updated to consume the lifted AwarenessCoalescer; semantics
// unchanged.

import AwarenessCoalescer = require('../../src/server/AwarenessCoalescer');

class NoopLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

function makeCoalescer() {
    const channelSends: Array<{ ch: string; msg: any }> = [];
    const router: any = {
        sendToChannel: jest.fn(async (ch: string, msg: any) => {
            channelSends.push({ ch, msg });
        }),
        broadcastToAll: jest.fn(async () => {}),
        onRemoteChannelMessage: jest.fn(),
    };
    const coalescer = new AwarenessCoalescer(router, new NoopLogger());
    return { coalescer, router, channelSends };
}

describe('AwarenessCoalescer', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('bufferUpdate schedules a flush after AWARENESS_BATCH_WINDOW_MS', async () => {
        const { coalescer, channelSends } = makeCoalescer();
        coalescer.bufferUpdate('c1', 'crdt:doc:1', 'base64data');
        expect(channelSends.length).toBe(0);
        await jest.runAllTimersAsync();
        expect(channelSends.length).toBe(1);
        expect(channelSends[0].ch).toBe('crdt:doc:1');
        expect(channelSends[0].msg.type).toBe('crdt:awareness');
    });

    test('multiple updates for same client: only latest is broadcast', async () => {
        const { coalescer, channelSends } = makeCoalescer();
        coalescer.bufferUpdate('c1', 'crdt:doc:1', 'update-v1');
        coalescer.bufferUpdate('c1', 'crdt:doc:1', 'update-v2');
        await jest.runAllTimersAsync();
        const updates = channelSends[0].msg.updates;
        expect(updates.length).toBe(1);
        expect(updates[0].update).toBe('update-v2');
    });

    test('updates from multiple clients are all included in the merged broadcast', async () => {
        const { coalescer, channelSends } = makeCoalescer();
        coalescer.bufferUpdate('c1', 'crdt:doc:1', 'upd-c1');
        coalescer.bufferUpdate('c2', 'crdt:doc:1', 'upd-c2');
        coalescer.bufferUpdate('c3', 'crdt:doc:1', 'upd-c3');
        await jest.runAllTimersAsync();
        const updates = channelSends[0].msg.updates;
        expect(updates.length).toBe(3);
        expect(updates.map((u: any) => u.clientId).sort()).toEqual(['c1', 'c2', 'c3']);
    });

    test('second bufferUpdate on same channel does not schedule a second timer', async () => {
        const { coalescer, channelSends } = makeCoalescer();
        coalescer.bufferUpdate('c1', 'crdt:doc:1', 'upd1');
        coalescer.bufferUpdate('c2', 'crdt:doc:1', 'upd2');
        await jest.runAllTimersAsync();
        expect(channelSends.length).toBe(1);
    });

    test('separate channels get separate flushes', async () => {
        const { coalescer, channelSends } = makeCoalescer();
        coalescer.bufferUpdate('c1', 'crdt:doc:A', 'upd-a');
        coalescer.bufferUpdate('c2', 'crdt:doc:B', 'upd-b');
        await jest.runAllTimersAsync();
        expect(channelSends.length).toBe(2);
        const channels = channelSends.map((s) => s.ch).sort();
        expect(channels).toEqual(['crdt:doc:A', 'crdt:doc:B']);
    });

    test('shutdown() clears pending timers and batches', async () => {
        const { coalescer, channelSends } = makeCoalescer();
        coalescer.bufferUpdate('c1', 'crdt:doc:1', 'upd');
        expect(coalescer.pendingCount).toBe(1);
        coalescer.shutdown();
        expect(coalescer.pendingCount).toBe(0);
        await jest.runAllTimersAsync();
        expect(channelSends.length).toBe(0);
    });

    test('pendingCount reflects active batches', () => {
        const { coalescer } = makeCoalescer();
        expect(coalescer.pendingCount).toBe(0);
        coalescer.bufferUpdate('c1', 'crdt:doc:1', 'upd');
        expect(coalescer.pendingCount).toBe(1);
        coalescer.bufferUpdate('c2', 'crdt:doc:2', 'upd');
        expect(coalescer.pendingCount).toBe(2);
    });

    test('broadcast payload includes channel field', async () => {
        const { coalescer, channelSends } = makeCoalescer();
        coalescer.bufferUpdate('c1', 'crdt:doc:X', 'upd');
        await jest.runAllTimersAsync();
        expect(channelSends[0].msg.channel).toBe('crdt:doc:X');
    });

    test('removeClient prunes a disconnected client from all channels (ghost-cursor fix)', async () => {
        const { coalescer, channelSends } = makeCoalescer();
        coalescer.bufferUpdate('c1', 'crdt:doc:A', 'upd-c1-A');
        coalescer.bufferUpdate('c2', 'crdt:doc:A', 'upd-c2-A');
        coalescer.bufferUpdate('c1', 'crdt:doc:B', 'upd-c1-B');

        const removedCount = coalescer.removeClient('c1');
        expect(removedCount).toBe(2);

        await jest.runAllTimersAsync();

        const docASend = channelSends.find((s) => s.ch === 'crdt:doc:A');
        expect(docASend!.msg.updates.length).toBe(1);
        expect(docASend!.msg.updates[0].clientId).toBe('c2');

        const docBSend = channelSends.find((s) => s.ch === 'crdt:doc:B');
        expect(docBSend).toBeUndefined();
    });

    test('removeClient is a no-op for an unknown client', () => {
        const { coalescer } = makeCoalescer();
        coalescer.bufferUpdate('c1', 'crdt:doc:1', 'upd');
        expect(coalescer.removeClient('unknown')).toBe(0);
        expect(coalescer.pendingCount).toBe(1);
    });

    test('broadcast logs error and does not throw when sendToChannel rejects', async () => {
        const errors: any[] = [];
        const router: any = {
            sendToChannel: jest.fn(async () => {
                throw new Error('redis pub/sub down');
            }),
            broadcastToAll: jest.fn(async () => {}),
            onRemoteChannelMessage: jest.fn(),
        };
        const logger = {
            debug(): void {},
            info(): void {},
            warn(): void {},
            error(...args: any[]): void { errors.push(args); },
        };
        const coalescer = new AwarenessCoalescer(router, logger);

        coalescer.bufferUpdate('c1', 'crdt:doc:X', 'upd');
        await jest.runAllTimersAsync();

        expect(router.sendToChannel).toHaveBeenCalledTimes(1);
        expect(errors.length).toBe(1);
        expect(errors[0][0]).toMatch(/Error flushing awareness batch/);
        expect(coalescer.pendingCount).toBe(0);
    });
});
