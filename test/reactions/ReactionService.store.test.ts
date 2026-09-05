// realtime-modules/test/reactions/ReactionService.store.test.ts
//
// The durable reaction path (v0.33.0).
//
// A reaction on a MESSAGE is state, not an event: it has to survive the
// reload, it has to be takeable-back by whoever placed it, and it has to be
// the same fact when two people look at it. A reaction thrown at a CALL is
// the opposite — an event that happened once. Both go through this service,
// and the only thing separating them is whether the frame names a target.
//
// These tests pin that split, and the three properties that make the durable
// half safe: nothing is broadcast that was not stored, nothing is stored
// without a known owner, and a replay is not a second set of reactions.

import { describe, it, expect, jest } from '@jest/globals';
import { ReactionService } from '../../dist/reactions/ReactionService';

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
        sendToLocalClient: (clientId: string, message: any) => sentToClient.push({ clientId, message }),
        sendToChannel: jest.fn((channel: string, message: any) => {
            sendToChannelCalls.push({ channel, message });
            return Promise.resolve();
        }),
        subscribeToChannel: jest.fn(() => Promise.resolve()),
        unsubscribeFromChannel: jest.fn(() => Promise.resolve()),
    };
    return { router, sentToClient, sendToChannelCalls };
}

/** In-memory ReactionStore keyed exactly like a real one. */
function makeStore(seed: any[] = []) {
    const rows = new Map<string, any>();
    for (const r of seed) rows.set(`${r.channel}|${r.targetId}|${r.emoji}|${r.userId}`, r);
    return {
        rows,
        add: jest.fn(async (r: any) => {
            rows.set(`${r.channel}|${r.targetId}|${r.emoji}|${r.userId}`, r);
        }),
        remove: jest.fn(async (k: any) => {
            rows.delete(`${k.channel}|${k.targetId}|${k.emoji}|${k.userId}`);
        }),
        list: jest.fn(async (channel: string) =>
            Array.from(rows.values()).filter((r) => r.channel === channel),
        ),
    };
}

const IDENTITY = { userId: 'u-bob', displayName: 'Bob Martinez' };

function makeService(router: any, extra: any = {}) {
    return new ReactionService({
        messageRouter: router,
        logger: new NoopLogger() as any,
        config: { identityResolver: () => IDENTITY, ...extra },
    });
}

function framesFor(sentToClient: any[], clientId: string, action: string) {
    return sentToClient.filter((f) => f.clientId === clientId && f.message?.action === action);
}

function errorsFor(sentToClient: any[], clientId: string) {
    return sentToClient.filter((f) => f.clientId === clientId && f.message?.type === 'error');
}

describe('targeted reactions are stored', () => {
    it('writes the reaction before it is broadcast', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const store = makeStore();
        const svc = makeService(router, { store });

        await svc.handleAction('c1', 'send', { channel: 'general', emoji: '👍', targetId: 'm1' });

        expect(store.add).toHaveBeenCalledTimes(1);
        expect(store.add.mock.calls[0][0]).toMatchObject({
            channel: 'general',
            targetId: 'm1',
            emoji: '👍',
            userId: 'u-bob',
            displayName: 'Bob Martinez',
        });
        expect(sendToChannelCalls).toHaveLength(1);
    });

    // The whole point of storing first. A reaction that fans out and then
    // fails to save reads as "it worked" right up until the reload.
    it('broadcasts nothing when the write fails', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const store = makeStore();
        store.add = jest.fn(async () => {
            throw new Error('table gone');
        }) as any;
        const svc = makeService(router, { store });

        await svc.handleAction('c1', 'send', { channel: 'general', emoji: '👍', targetId: 'm1' });

        expect(sendToChannelCalls).toHaveLength(0);
        expect(errorsFor(sentToClient, 'c1')).toHaveLength(1);
    });

    // A reaction the server cannot attribute can never be taken back, so
    // persisting it would leave a chip nobody can clear.
    it('refuses a targeted reaction from an unidentified connection', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const store = makeStore();
        const svc = new ReactionService({
            messageRouter: router,
            logger: new NoopLogger() as any,
            config: { store },
        });

        await svc.handleAction('c1', 'send', { channel: 'general', emoji: '👍', targetId: 'm1' });

        expect(store.add).not.toHaveBeenCalled();
        expect(sendToChannelCalls).toHaveLength(0);
        expect(errorsFor(sentToClient, 'c1')).toHaveLength(1);
    });

    // The floating emoji thrown at a call is an event, not state.
    it('leaves untargeted call reactions ephemeral', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const store = makeStore();
        const svc = makeService(router, { store });

        await svc.handleAction('c1', 'send', { channel: 'call:standup', emoji: '🎉' });

        expect(store.add).not.toHaveBeenCalled();
        expect(sendToChannelCalls).toHaveLength(1);
    });

    it('stays ephemeral when no store is wired at all', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const svc = makeService(router);
        await svc.handleAction('c1', 'send', { channel: 'general', emoji: '👍', targetId: 'm1' });
        expect(sendToChannelCalls).toHaveLength(1);
    });
});

describe('replay on subscribe', () => {
    it('sends the stored reactions to the client that just subscribed', async () => {
        const { router, sentToClient } = makeRouter();
        const store = makeStore([
            { channel: 'general', targetId: 'm1', emoji: '👍', userId: 'u-hank', displayName: 'Hank', timestamp: '2026-09-05T07:00:00.000Z' },
        ]);
        const svc = makeService(router, { store });

        await svc.handleAction('c1', 'subscribe', { channel: 'general' });

        const [history] = framesFor(sentToClient, 'c1', 'reaction_history');
        expect(history.message.data.channel).toBe('general');
        expect(history.message.data.reactions).toHaveLength(1);
        expect(history.message.data.reactions[0]).toMatchObject({
            emoji: '👍',
            targetId: 'm1',
            userId: 'u-hank',
            displayName: 'Hank',
        });
    });

    // Replaying must not read as new reactions arriving: the id is derived
    // from the durable key, so the same fact is the same id every time.
    it('gives the same reaction the same id on every replay', async () => {
        const { router, sentToClient } = makeRouter();
        const store = makeStore([
            { channel: 'general', targetId: 'm1', emoji: '👍', userId: 'u-hank', timestamp: '2026-09-05T07:00:00.000Z' },
        ]);
        const svc = makeService(router, { store });

        await svc.handleAction('c1', 'subscribe', { channel: 'general' });
        await svc.handleAction('c2', 'subscribe', { channel: 'general' });

        const ids = [
            ...framesFor(sentToClient, 'c1', 'reaction_history'),
            ...framesFor(sentToClient, 'c2', 'reaction_history'),
        ].map((f) => f.message.data.reactions[0].id);
        expect(ids[0]).toBe(ids[1]);
    });

    it('replays after the subscribe ack, so the channel is live first', async () => {
        const { router, sentToClient } = makeRouter();
        const store = makeStore([
            { channel: 'general', targetId: 'm1', emoji: '👍', userId: 'u-hank', timestamp: 'x' },
        ]);
        const svc = makeService(router, { store });

        await svc.handleAction('c1', 'subscribe', { channel: 'general' });

        const actions = sentToClient.filter((f) => f.clientId === 'c1').map((f) => f.message.action);
        expect(actions.indexOf('reaction_subscribed')).toBeLessThan(actions.indexOf('reaction_history'));
    });

    // Losing the live feed because a table blinked is the worse outcome.
    it('still subscribes when the history read fails', async () => {
        const { router, sentToClient } = makeRouter();
        const store = makeStore();
        store.list = jest.fn(async () => {
            throw new Error('table gone');
        }) as any;
        const svc = makeService(router, { store });

        await svc.handleAction('c1', 'subscribe', { channel: 'general' });

        expect(framesFor(sentToClient, 'c1', 'reaction_subscribed')).toHaveLength(1);
        expect(framesFor(sentToClient, 'c1', 'reaction_history')).toHaveLength(0);
    });

    it('sends no history frame when there is no store', async () => {
        const { router, sentToClient } = makeRouter();
        const svc = makeService(router);
        await svc.handleAction('c1', 'subscribe', { channel: 'general' });
        expect(framesFor(sentToClient, 'c1', 'reaction_history')).toHaveLength(0);
    });
});

describe('removing a reaction', () => {
    it('deletes the row and tells the channel', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const store = makeStore([
            { channel: 'general', targetId: 'm1', emoji: '👍', userId: 'u-bob', timestamp: 'x' },
        ]);
        const svc = makeService(router, { store });

        await svc.handleAction('c1', 'remove', { channel: 'general', emoji: '👍', targetId: 'm1' });

        expect(store.rows.size).toBe(0);
        expect(sendToChannelCalls[0].message).toMatchObject({
            action: 'reaction_removed',
            data: { channel: 'general', targetId: 'm1', emoji: '👍', userId: 'u-bob' },
        });
    });

    // The broadcast already reaches the sender. An ack sharing the broadcast's
    // verb would make the client apply the removal twice.
    it('acks under a different verb than it broadcasts', async () => {
        const { router, sentToClient } = makeRouter();
        const svc = makeService(router, { store: makeStore() });

        await svc.handleAction('c1', 'remove', { channel: 'general', emoji: '👍', targetId: 'm1' });

        expect(framesFor(sentToClient, 'c1', 'reaction_unsent')).toHaveLength(1);
        expect(framesFor(sentToClient, 'c1', 'reaction_removed')).toHaveLength(0);
    });

    // Two clicks racing on one chip should settle on "not reacted".
    it('succeeds when the reaction was already gone', async () => {
        const { router, sentToClient } = makeRouter();
        const svc = makeService(router, { store: makeStore() });
        await svc.handleAction('c1', 'remove', { channel: 'general', emoji: '👍', targetId: 'm1' });
        expect(errorsFor(sentToClient, 'c1')).toHaveLength(0);
    });

    it('removes only the caller own reaction, never someone else', async () => {
        const { router } = makeRouter();
        const store = makeStore([
            { channel: 'general', targetId: 'm1', emoji: '👍', userId: 'u-bob', timestamp: 'x' },
            { channel: 'general', targetId: 'm1', emoji: '👍', userId: 'u-hank', timestamp: 'x' },
        ]);
        const svc = makeService(router, { store });

        await svc.handleAction('c1', 'remove', { channel: 'general', emoji: '👍', targetId: 'm1' });

        expect(Array.from(store.rows.values()).map((r: any) => r.userId)).toEqual(['u-hank']);
    });

    it('refuses a removal that names no target', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const svc = makeService(router, { store: makeStore() });
        await svc.handleAction('c1', 'remove', { channel: 'general', emoji: '👍' });
        expect(errorsFor(sentToClient, 'c1')).toHaveLength(1);
        expect(sendToChannelCalls).toHaveLength(0);
    });

    it('refuses a removal from an unidentified connection', async () => {
        const { router, sentToClient } = makeRouter();
        const store = makeStore();
        const svc = new ReactionService({
            messageRouter: router,
            logger: new NoopLogger() as any,
            config: { store },
        });
        await svc.handleAction('c1', 'remove', { channel: 'general', emoji: '👍', targetId: 'm1' });
        expect(store.remove).not.toHaveBeenCalled();
        expect(errorsFor(sentToClient, 'c1')).toHaveLength(1);
    });

    it('says so when the server keeps no durable reactions', async () => {
        const { router, sentToClient } = makeRouter();
        const svc = makeService(router);
        await svc.handleAction('c1', 'remove', { channel: 'general', emoji: '👍', targetId: 'm1' });
        expect(errorsFor(sentToClient, 'c1')).toHaveLength(1);
    });

    // Losing room ownership drops the transient ring; it must not drop the
    // stored reactions, which are channel state.
    it('keeps stored reactions when the room is cleaned up', async () => {
        const { router } = makeRouter();
        const store = makeStore([
            { channel: 'general', targetId: 'm1', emoji: '👍', userId: 'u-bob', timestamp: 'x' },
        ]);
        const svc = makeService(router, { store });
        await svc.cleanupRoom('general');
        expect(store.rows.size).toBe(1);
    });
});
