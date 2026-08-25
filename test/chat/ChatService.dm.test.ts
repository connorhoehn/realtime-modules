// realtime-modules/test/chat/ChatService.dm.test.ts
//
// v0.23.0 — person-to-person DM support in the chat layer:
//
//   1. identityResolver → first-class `userId` stamped on sent messages,
//      displayName/avatarUrl merged into metadata (sender wins).
//   2. enforceDmMembership → join/send to member-addressed chat:dm:*
//      channels is gated on the resolved userId being in the member list
//      (fail-closed; error frame code CHAT_DM_FORBIDDEN). Non-dm channels
//      untouched.
//   3. onDmMessage → fire-and-forget dm activity seam after a successful
//      dm send (parsed members; [] for hashed chat:dmg: channels).

import { describe, it, expect, jest } from '@jest/globals';
import { ChatService } from '../../dist/chat/ChatService';
import { InMemoryChatStore } from '../../dist/chat/ChatStore';
import { dmChatChannelFor } from '../../dist/chat/dmChannels';

// ---------------------------------------------------------------------------
// Helpers (same harness style as ChatService.authz.test.ts)
// ---------------------------------------------------------------------------

class NoopLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

/** Captures sendToClient frames + sendToChannel calls for assertions. */
function makeRouter() {
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
        subscribeToChannel: jest.fn((_clientId: string, _channel: string) => Promise.resolve(true)),
        unsubscribeFromChannel: jest.fn(() => Promise.resolve()),
    };
    return { router, sentToClient, sendToChannelCalls };
}

function makeService(router: any, extraOpts: Record<string, any> = {}) {
    return new ChatService({
        messageRouter: router,
        logger: new NoopLogger() as any,
        ...extraOpts,
    });
}

/** dev-hank / dev-alice are known; anything else resolves to null. */
const directory: Record<string, { userId: string; displayName?: string; avatarUrl?: string }> = {
    'conn-hank': { userId: 'dev-hank', displayName: 'Hank', avatarUrl: 'https://a/hank.png' },
    'conn-alice': { userId: 'dev-alice', displayName: 'Alice' },
    'conn-anon': null as any, // resolver returns null → no identity
};
const resolver = (clientId: string) => directory[clientId] ?? null;

function joinedAcks(sentToClient: any[]) {
    return sentToClient.filter((f) => f.message?.type === 'chat' && f.message?.action === 'joined');
}
function errorFrames(sentToClient: any[], code: string) {
    return sentToClient.filter(
        (f) => f.message?.type === 'error' && f.message?.error?.code === code,
    );
}

const DM_HANK_ALICE = dmChatChannelFor(['dev-hank', 'dev-alice']); // chat:dm:dev-alice:dev-hank

// ---------------------------------------------------------------------------
// 1. Identity stamping
// ---------------------------------------------------------------------------

describe('ChatService identityResolver — userId stamping', () => {
    it('stamps message.userId and merges displayName/avatarUrl into metadata', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const svc = makeService(router, { identityResolver: resolver });
        await svc.handleJoinChannel('conn-hank', { channel: 'chat:general' });
        await svc.handleSendMessage('conn-hank', { channel: 'chat:general', message: 'hi' });

        expect(sendToChannelCalls).toHaveLength(1);
        const msg = sendToChannelCalls[0].message.message;
        expect(msg.userId).toBe('dev-hank');
        expect(msg.clientId).toBe('conn-hank'); // clientId still the connection id
        expect(msg.metadata.displayName).toBe('Hank');
        expect(msg.metadata.avatarUrl).toBe('https://a/hank.png');
    });

    it('sender-provided metadata wins over resolver hints', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const svc = makeService(router, { identityResolver: resolver });
        await svc.handleJoinChannel('conn-hank', { channel: 'chat:general' });
        await svc.handleSendMessage('conn-hank', {
            channel: 'chat:general',
            message: 'hi',
            metadata: { displayName: 'The Hankster' },
        });

        const msg = sendToChannelCalls[0].message.message;
        expect(msg.metadata.displayName).toBe('The Hankster'); // sender wins
        expect(msg.metadata.avatarUrl).toBe('https://a/hank.png'); // hole filled by resolver
    });

    it('no resolver → behavior identical to today (no userId, metadata untouched)', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const svc = makeService(router);
        await svc.handleJoinChannel('conn-x', { channel: 'chat:general' });
        await svc.handleSendMessage('conn-x', { channel: 'chat:general', message: 'hi' });

        const msg = sendToChannelCalls[0].message.message;
        expect(msg.userId).toBeUndefined();
        expect(msg.metadata).toEqual({});
    });

    it('resolver yields no userId → no stamp, send still goes out on non-dm channels', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const svc = makeService(router, { identityResolver: resolver });
        await svc.handleJoinChannel('conn-anon', { channel: 'chat:general' });
        await svc.handleSendMessage('conn-anon', { channel: 'chat:general', message: 'hi' });

        expect(sendToChannelCalls).toHaveLength(1);
        expect(sendToChannelCalls[0].message.message.userId).toBeUndefined();
    });

    it('userId round-trips through the ChatStore', async () => {
        const store = new InMemoryChatStore();
        const { router } = makeRouter();
        const svc = makeService(router, { identityResolver: resolver, chatStore: store });
        await svc.handleJoinChannel('conn-hank', { channel: 'chat:general' });
        await svc.handleSendMessage('conn-hank', { channel: 'chat:general', message: 'persisted' });

        const listed = await store.listMessages('chat:general', 10);
        expect(listed).toHaveLength(1);
        expect(listed[0].userId).toBe('dev-hank');
        expect(listed[0].clientId).toBe('conn-hank');
    });
});

// ---------------------------------------------------------------------------
// 2. DM membership enforcement
// ---------------------------------------------------------------------------

describe('ChatService enforceDmMembership', () => {
    it('member may join a chat:dm channel (ack + local subscription)', async () => {
        const { router, sentToClient } = makeRouter();
        const svc = makeService(router, { identityResolver: resolver });
        await svc.handleJoinChannel('conn-hank', { channel: DM_HANK_ALICE });

        expect(joinedAcks(sentToClient)).toHaveLength(1);
        expect(svc.clientChannels.hasSubscription('conn-hank', DM_HANK_ALICE)).toBe(true);
    });

    it('non-member join is rejected with CHAT_DM_FORBIDDEN (no ack, no sub, no router subscribe)', async () => {
        const { router, sentToClient } = makeRouter();
        const svc = makeService(router, { identityResolver: () => ({ userId: 'dev-carol' }) });
        await svc.handleJoinChannel('conn-carol', { channel: DM_HANK_ALICE });

        const errs = errorFrames(sentToClient, 'CHAT_DM_FORBIDDEN');
        expect(errs).toHaveLength(1);
        expect(errs[0].message.service).toBe('chat');
        expect(joinedAcks(sentToClient)).toHaveLength(0);
        expect(svc.clientChannels.hasSubscription('conn-carol', DM_HANK_ALICE)).toBe(false);
        expect(router.subscribeToChannel).not.toHaveBeenCalled();
    });

    it('non-member send is rejected even with a pre-existing subscription (no broadcast)', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const svc = makeService(router, { identityResolver: () => ({ userId: 'dev-carol' }) });
        // Simulate a subscription acquired before enforcement (or via a bug).
        svc.clientChannels.addSubscription('conn-carol', DM_HANK_ALICE);

        await svc.handleSendMessage('conn-carol', { channel: DM_HANK_ALICE, message: 'sneak' });

        expect(errorFrames(sentToClient, 'CHAT_DM_FORBIDDEN')).toHaveLength(1);
        expect(sendToChannelCalls).toHaveLength(0);
    });

    it('member send goes through, stamped with userId', async () => {
        const { router, sendToChannelCalls } = makeRouter();
        const svc = makeService(router, { identityResolver: resolver });
        await svc.handleJoinChannel('conn-alice', { channel: DM_HANK_ALICE });
        await svc.handleSendMessage('conn-alice', { channel: DM_HANK_ALICE, message: 'hey hank' });

        expect(sendToChannelCalls).toHaveLength(1);
        expect(sendToChannelCalls[0].message.message.userId).toBe('dev-alice');
    });

    it('FAIL-CLOSED: unresolvable identity is rejected on dm channels', async () => {
        const { router, sentToClient } = makeRouter();
        const svc = makeService(router, { identityResolver: resolver });
        // conn-anon → resolver returns null
        await svc.handleJoinChannel('conn-anon', { channel: DM_HANK_ALICE });
        expect(errorFrames(sentToClient, 'CHAT_DM_FORBIDDEN')).toHaveLength(1);
        expect(joinedAcks(sentToClient)).toHaveLength(0);
    });

    it('FAIL-CLOSED: enforceDmMembership:true without any resolver rejects dm joins', async () => {
        const { router, sentToClient } = makeRouter();
        const svc = makeService(router, { enforceDmMembership: true });
        await svc.handleJoinChannel('conn-x', { channel: DM_HANK_ALICE });
        expect(errorFrames(sentToClient, 'CHAT_DM_FORBIDDEN')).toHaveLength(1);
    });

    it('FAIL-CLOSED: throwing resolver is treated as no identity → rejected', async () => {
        const { router, sentToClient } = makeRouter();
        const svc = makeService(router, {
            identityResolver: () => {
                throw new Error('directory down');
            },
        });
        await svc.handleJoinChannel('conn-x', { channel: DM_HANK_ALICE });
        expect(errorFrames(sentToClient, 'CHAT_DM_FORBIDDEN')).toHaveLength(1);
    });

    it('default is OFF without a resolver (dm channels behave like any channel)', async () => {
        const { router, sentToClient } = makeRouter();
        const svc = makeService(router); // no resolver, no explicit flag
        expect(svc.enforceDmMembership).toBe(false);
        await svc.handleJoinChannel('conn-x', { channel: DM_HANK_ALICE });
        expect(joinedAcks(sentToClient)).toHaveLength(1);
    });

    it('defaults ON when a resolver is provided; explicit false wins', async () => {
        const { router: r1 } = makeRouter();
        expect(makeService(r1, { identityResolver: resolver }).enforceDmMembership).toBe(true);

        const { router: r2, sentToClient } = makeRouter();
        const svc = makeService(r2, { identityResolver: () => ({ userId: 'dev-carol' }), enforceDmMembership: false });
        await svc.handleJoinChannel('conn-carol', { channel: DM_HANK_ALICE });
        expect(joinedAcks(sentToClient)).toHaveLength(1); // non-member allowed when disabled
    });

    it('non-dm channels are completely unaffected by enforcement', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const svc = makeService(router, { identityResolver: () => ({ userId: 'dev-carol' }) });
        await svc.handleJoinChannel('conn-carol', { channel: 'chat:general' });
        await svc.handleSendMessage('conn-carol', { channel: 'chat:general', message: 'hi' });

        expect(joinedAcks(sentToClient)).toHaveLength(1);
        expect(errorFrames(sentToClient, 'CHAT_DM_FORBIDDEN')).toHaveLength(0);
        expect(sendToChannelCalls).toHaveLength(1);
    });

    it('hashed chat:dmg: channels are not enforced here (membership not parseable)', async () => {
        const { router, sentToClient } = makeRouter();
        const svc = makeService(router, { identityResolver: () => ({ userId: 'dev-carol' }) });
        await svc.handleJoinChannel('conn-carol', { channel: 'chat:dmg:0123456789abcdef01234567' });
        expect(joinedAcks(sentToClient)).toHaveLength(1);
        expect(errorFrames(sentToClient, 'CHAT_DM_FORBIDDEN')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// 3. onDmMessage activity seam
// ---------------------------------------------------------------------------

describe('ChatService onDmMessage seam', () => {
    it('fires after a successful dm send with parsed members + the stamped message', async () => {
        const calls: any[] = [];
        const { router } = makeRouter();
        const svc = makeService(router, {
            identityResolver: resolver,
            onDmMessage: (info: any) => calls.push(info),
        });
        await svc.handleJoinChannel('conn-hank', { channel: DM_HANK_ALICE });
        await svc.handleSendMessage('conn-hank', { channel: DM_HANK_ALICE, message: 'yo' });

        expect(calls).toHaveLength(1);
        expect(calls[0].channel).toBe(DM_HANK_ALICE);
        expect(calls[0].members).toEqual(['dev-alice', 'dev-hank']);
        expect(calls[0].message.userId).toBe('dev-hank');
        expect(calls[0].message.message).toBe('yo');
    });

    it('does NOT fire for non-dm channels', async () => {
        const calls: any[] = [];
        const { router } = makeRouter();
        const svc = makeService(router, {
            identityResolver: resolver,
            onDmMessage: (info: any) => calls.push(info),
        });
        await svc.handleJoinChannel('conn-hank', { channel: 'chat:general' });
        await svc.handleSendMessage('conn-hank', { channel: 'chat:general', message: 'yo' });
        expect(calls).toHaveLength(0);
    });

    it('does NOT fire when the dm send is rejected by membership enforcement', async () => {
        const calls: any[] = [];
        const { router } = makeRouter();
        const svc = makeService(router, {
            identityResolver: () => ({ userId: 'dev-carol' }),
            onDmMessage: (info: any) => calls.push(info),
        });
        svc.clientChannels.addSubscription('conn-carol', DM_HANK_ALICE);
        await svc.handleSendMessage('conn-carol', { channel: DM_HANK_ALICE, message: 'sneak' });
        expect(calls).toHaveLength(0);
    });

    it('passes members:[] for hashed chat:dmg: channels', async () => {
        const calls: any[] = [];
        const dmg = 'chat:dmg:0123456789abcdef01234567';
        const { router } = makeRouter();
        const svc = makeService(router, {
            identityResolver: resolver,
            onDmMessage: (info: any) => calls.push(info),
        });
        await svc.handleJoinChannel('conn-hank', { channel: dmg });
        await svc.handleSendMessage('conn-hank', { channel: dmg, message: 'group hi' });

        expect(calls).toHaveLength(1);
        expect(calls[0].members).toEqual([]);
    });

    it('a throwing hook never fails the send (sent ack + broadcast still happen)', async () => {
        const { router, sentToClient, sendToChannelCalls } = makeRouter();
        const svc = makeService(router, {
            identityResolver: resolver,
            onDmMessage: () => {
                throw new Error('index down');
            },
        });
        await svc.handleJoinChannel('conn-hank', { channel: DM_HANK_ALICE });
        await svc.handleSendMessage('conn-hank', { channel: DM_HANK_ALICE, message: 'yo' });

        expect(sendToChannelCalls).toHaveLength(1);
        const sentAcks = sentToClient.filter(
            (f) => f.message?.type === 'chat' && f.message?.action === 'sent',
        );
        expect(sentAcks).toHaveLength(1);
    });
});
