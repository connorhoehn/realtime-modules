// realtime-modules/test/chat/ChatService.authz.test.ts
//
// M3 gaps #9 + #10 — ChatService wire-authz regressions.
//
// Gap #9 (serious): chat sends bypassed publisher authz. handleSendMessage
//   broadcasts via messageRouter.sendToChannel WITHOUT excludeClientId (so the
//   sender gets their own echo). The gateway router's publisher-authz check was
//   gated on excludeClientId, so ChatRoom CRD publisher restrictions never
//   applied to chat. Fix: ChatService passes the sender as the explicit
//   publisherClientId option, decoupling AUTHZ subject from ECHO control.
//
// Gap #10: handleJoinChannel ignored subscribeToChannel's `false` return — it
//   acked {type:'chat',action:'joined'} and registered a local subscription
//   even when the router denied the subscribe (and had already emitted
//   AUTHZ_CHANNEL_DENIED). Fix: on `false`, no joined ack, no local sub.

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ChatService } from '../../dist/chat/ChatService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class NoopLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

/** Captures sendToClient frames + sendToChannel calls for assertions. */
function makeRouter(opts: { subscribeReturns?: boolean | void } = {}) {
    const sentToClient: any[] = [];
    const sendToChannelCalls: any[] = [];
    const router: any = {
        redisAvailable: true,
        sendToClient: (clientId: string, message: any) => {
            sentToClient.push({ clientId, message });
        },
        sendToChannel: jest.fn(
            (channel: string, message: any, excludeClientId?: string | null, opts?: any) => {
                sendToChannelCalls.push({ channel, message, excludeClientId, opts });
                return Promise.resolve();
            },
        ),
        subscribeToChannel: jest.fn(
            (_clientId: string, _channel: string) => Promise.resolve(opts.subscribeReturns),
        ),
        unsubscribeFromChannel: jest.fn(() => Promise.resolve()),
    };
    return { router, sentToClient, sendToChannelCalls };
}

function makeService(router: any) {
    return new ChatService({ messageRouter: router, logger: new NoopLogger() as any });
}

// ---------------------------------------------------------------------------
// Gap #9 — publisher identity flows to the router
// ---------------------------------------------------------------------------

describe('ChatService gap #9 — publisher identity flows to sendToChannel', () => {
    it('handleSendMessage passes the sender as publisherClientId, NOT excludeClientId', async () => {
        const { router, sendToChannelCalls } = makeRouter({ subscribeReturns: true });
        const svc = makeService(router);
        // join first (send requires a prior local subscription)
        await svc.handleJoinChannel('clientA', { channel: 'chat:room1' });

        await svc.handleSendMessage('clientA', { channel: 'chat:room1', message: 'hello' });

        expect(sendToChannelCalls).toHaveLength(1);
        const call = sendToChannelCalls[0];
        // AUTHZ subject is named explicitly so the router can enforce CRD
        // publisher restrictions...
        expect(call.opts).toEqual({ publisherClientId: 'clientA' });
        // ...while echo control stays null so the sender still receives the
        // broadcast (sender-echo — the swarm chat verification depends on it).
        expect(call.excludeClientId).toBeNull();
    });

    it('broadcastMessage(channel, data, publisherClientId) threads the option through', async () => {
        const { router, sendToChannelCalls } = makeRouter({ subscribeReturns: true });
        const svc = makeService(router);
        await svc.broadcastMessage('chat:room1', { id: 'm1', message: 'x' } as any, 'pub-1');
        expect(sendToChannelCalls[0].opts).toEqual({ publisherClientId: 'pub-1' });
        expect(sendToChannelCalls[0].excludeClientId).toBeNull();
    });

    it('broadcastMessage without a publisher keeps the legacy 1-arg call (back-compat)', async () => {
        const { router, sendToChannelCalls } = makeRouter({ subscribeReturns: true });
        const svc = makeService(router);
        await svc.broadcastMessage('chat:room1', { id: 'm1', message: 'x' } as any);
        // Legacy shape: no extra args → undefined excludeClientId/opts.
        expect(sendToChannelCalls[0].excludeClientId).toBeUndefined();
        expect(sendToChannelCalls[0].opts).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Gap #10 — handleJoinChannel respects subscribe denial
// ---------------------------------------------------------------------------

describe('ChatService gap #10 — handleJoinChannel respects subscribe denial', () => {
    let svc: any;
    let sentToClient: any[];
    let router: any;

    function setup(subscribeReturns: boolean | void) {
        const made = makeRouter({ subscribeReturns });
        router = made.router;
        sentToClient = made.sentToClient;
        svc = makeService(router);
    }

    it('subscribe denied (false) → NO joined ack, NO local subscription', async () => {
        setup(false);
        await svc.handleJoinChannel('clientA', { channel: 'chat:restricted' });

        const joinedAcks = sentToClient.filter(
            (f) => f.message?.type === 'chat' && f.message?.action === 'joined',
        );
        expect(joinedAcks).toHaveLength(0);
        // Local subscription must not be registered — a subsequent send must be
        // rejected with "must join the channel before sending messages".
        expect(svc.clientChannels.hasSubscription('clientA', 'chat:restricted')).toBe(false);
    });

    it('subscribe permitted (true) → joined ack + local subscription', async () => {
        setup(true);
        await svc.handleJoinChannel('clientA', { channel: 'chat:open' });

        const joinedAcks = sentToClient.filter(
            (f) => f.message?.type === 'chat' && f.message?.action === 'joined',
        );
        expect(joinedAcks).toHaveLength(1);
        expect(svc.clientChannels.hasSubscription('clientA', 'chat:open')).toBe(true);
    });

    it('subscribe returns void (legacy router) → treated as permitted', async () => {
        setup(undefined);
        await svc.handleJoinChannel('clientA', { channel: 'chat:legacy' });
        const joinedAcks = sentToClient.filter(
            (f) => f.message?.type === 'chat' && f.message?.action === 'joined',
        );
        expect(joinedAcks).toHaveLength(1);
        expect(svc.clientChannels.hasSubscription('clientA', 'chat:legacy')).toBe(true);
    });
});
