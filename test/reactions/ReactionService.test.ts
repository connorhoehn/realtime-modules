// realtime-modules/test/reactions/ReactionService.test.ts
//
// Call-reaction identity + durable-capture seam (v0.24.0):
//   - identityResolver stamps userId/displayName onto broadcast frames
//     (resolved at send time, never trusted from the inbound frame; a
//     throwing resolver is logged and treated as "no identity").
//   - onReaction post-broadcast tap fires with the full Reaction and is
//     fire-and-forget: sync throws and rejected promises are swallowed —
//     the success ack still goes out.
//   - top-level `targetId` on the inbound send frame is carried onto the
//     Reaction verbatim (opaque passthrough; the client hook depends on it).

import { describe, it, expect, jest } from '@jest/globals';
import { ReactionService } from '../../dist/reactions/ReactionService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class NoopLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

/** Captures sendToLocalClient frames + sendToChannel calls for assertions. */
function makeRouter() {
    const sentToClient: any[] = [];
    const sendToChannelCalls: any[] = [];
    const router: any = {
        sendToLocalClient: (clientId: string, message: any) => {
            sentToClient.push({ clientId, message });
        },
        sendToChannel: jest.fn((channel: string, message: any) => {
            sendToChannelCalls.push({ channel, message });
            return Promise.resolve();
        }),
        subscribeToChannel: jest.fn(() => Promise.resolve()),
        unsubscribeFromChannel: jest.fn(() => Promise.resolve()),
    };
    return { router, sentToClient, sendToChannelCalls };
}

function makeService(router: any, config: any = {}) {
    return new ReactionService({
        messageRouter: router,
        logger: new NoopLogger() as any,
        config,
    });
}

/** The success-ack frames a client received, filtered by action. */
function acksFor(sentToClient: any[], clientId: string, action: string) {
    return sentToClient.filter(
        (f) => f.clientId === clientId && f.message?.action === action && f.message?.success === true,
    );
}

// ---------------------------------------------------------------------------
// identityResolver — stamped on broadcast frames
// ---------------------------------------------------------------------------

describe('ReactionService identityResolver', () => {
    it('stamps userId/displayName from the resolver onto the broadcast reaction', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const svc = makeService(router, {
            identityResolver: (clientId: string) => ({ userId: `user-${clientId}`, displayName: 'Ada' }),
        });

        await svc.handleSendReaction('c1', { channel: 'call:standup', emoji: '❤️' });

        expect(sendToChannelCalls).toHaveLength(1);
        const broadcast = sendToChannelCalls[0].message.data;
        expect(broadcast.userId).toBe('user-c1');
        expect(broadcast.displayName).toBe('Ada');
        expect(broadcast.clientId).toBe('c1');
    });

    it('tolerates a null-returning resolver (no identity fields stamped)', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const svc = makeService(router, { identityResolver: () => null });

        await svc.handleSendReaction('c1', { channel: 'call:standup', emoji: '❤️' });

        const broadcast = sendToChannelCalls[0].message.data;
        expect(broadcast.userId).toBeUndefined();
        expect(broadcast.displayName).toBeUndefined();
    });

    it('tolerates a throwing resolver — send still succeeds, no identity stamped', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const svc = makeService(router, {
            identityResolver: () => {
                throw new Error('resolver boom');
            },
        });

        await svc.handleSendReaction('c1', { channel: 'call:standup', emoji: '❤️' });

        expect(sendToChannelCalls).toHaveLength(1);
        expect(sendToChannelCalls[0].message.data.userId).toBeUndefined();
        expect(acksFor(sentToClient, 'c1', 'reaction_sent')).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// onReaction — post-broadcast fire-and-forget tap
// ---------------------------------------------------------------------------

describe('ReactionService onReaction tap', () => {
    it('invokes onReaction with the full reaction (identity + targetId included)', async () => {
        const { router } = makeRouter();
        const seen: any[] = [];
        const svc = makeService(router, {
            identityResolver: () => ({ userId: 'u1', displayName: 'Ada' }),
            onReaction: (reaction: any) => {
                seen.push(reaction);
            },
        });

        await svc.handleSendReaction('c1', {
            channel: 'call:standup',
            emoji: '\u{1F389}',
            targetId: 'participant-7',
        } as any);

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            clientId: 'c1',
            channel: 'call:standup',
            emoji: '\u{1F389}',
            effect: 'confetti',
            userId: 'u1',
            displayName: 'Ada',
            targetId: 'participant-7',
        });
        expect(typeof seen[0].id).toBe('string');
        expect(typeof seen[0].timestamp).toBe('string');
    });

    it('a throwing onReaction does not break the send — success ack still sent', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const svc = makeService(router, {
            onReaction: () => {
                throw new Error('tap boom');
            },
        });

        await svc.handleSendReaction('c1', { channel: 'call:standup', emoji: '❤️' });

        expect(sendToChannelCalls).toHaveLength(1);
        expect(acksFor(sentToClient, 'c1', 'reaction_sent')).toHaveLength(1);
        // No error frame emitted to the sender.
        expect(sentToClient.some((f) => f.message?.type === 'error')).toBe(false);
    });

    it('a rejecting async onReaction is swallowed (no unhandled rejection, ack sent)', async () => {
        const { router, sentToClient } = makeRouter();
        const svc = makeService(router, {
            onReaction: async () => {
                throw new Error('async tap boom');
            },
        });

        await svc.handleSendReaction('c1', { channel: 'call:standup', emoji: '❤️' });
        // Let the rejected promise settle through the .catch handler.
        await new Promise((resolve) => setImmediate(resolve));

        expect(acksFor(sentToClient, 'c1', 'reaction_sent')).toHaveLength(1);
    });

    it('is invoked AFTER the broadcast has been dispatched', async () => {
        const { router } = makeRouter();
        const order: string[] = [];
        router.sendToChannel = jest.fn(() => {
            order.push('broadcast');
            return Promise.resolve();
        });
        const svc = makeService(router, {
            onReaction: () => {
                order.push('tap');
            },
        });

        await svc.handleSendReaction('c1', { channel: 'call:standup', emoji: '❤️' });

        expect(order).toEqual(['broadcast', 'tap']);
    });
});

// ---------------------------------------------------------------------------
// targetId — opaque top-level passthrough
// ---------------------------------------------------------------------------

describe('ReactionService targetId passthrough', () => {
    it('carries a top-level targetId from the inbound frame onto the broadcast', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const svc = makeService(router, {});

        await svc.handleSendReaction('c1', {
            channel: 'doc:review',
            emoji: '\u{1F44D}',
            targetId: 'comment-42',
        } as any);

        expect(sendToChannelCalls[0].message.data.targetId).toBe('comment-42');
    });

    it('omits targetId entirely when the frame does not carry one', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const svc = makeService(router, {});

        await svc.handleSendReaction('c1', { channel: 'doc:review', emoji: '\u{1F44D}' });

        expect('targetId' in sendToChannelCalls[0].message.data).toBe(false);
    });
});
