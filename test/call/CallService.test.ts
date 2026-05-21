// realtime-modules/test/call/CallService.test.ts
//
// Lifted + adapted from gateway's test/call-service.test.js (Wave 2
// catch-up). Coverage targets:
//   - getClientsByUserId seam (no localClients access).
//   - Promise.allSettled delivery accounting (partial / closed-socket /
//     async-reject / all-ok).
//   - Consumer-injected recordCallAction hook (replaces the old prom +
//     MetricsCollector dual-emit; consumers wire whichever sink they want).
//   - ALLOWED_CALL_ACTIONS validation (unknown verb, casing, null).
//   - Invite required-field validation (callId + lobbyName).
//   - Target shape variants (singular, plural, mixed/deduped, garbage-in).
//   - Broadcast routing (empty payload, explicit [], sender-exclusion).
//   - Sender exclusion + multi-tab semantics.
//   - Per-action propagation shapes (decline / end / accepted).
//   - No matching recipients (delivered=0/0 path).
//   - Outer catch on broadcastToAll throw.
//   - getStats / defensive fallbacks / authorize hook denial.

import { CallService } from '../../src/call/CallService';
import type {
    CallAction,
    CallLogger,
    CallMessageRouter,
    UserClientMatch,
} from '../../src/call/types';

interface LogEntry {
    msg: string;
    args: unknown[];
}

class MockLogger implements CallLogger {
    logs: { debug: LogEntry[]; info: LogEntry[]; warn: LogEntry[]; error: LogEntry[] } = {
        debug: [],
        info: [],
        warn: [],
        error: [],
    };
    debug(msg: string, ...args: unknown[]): void {
        this.logs.debug.push({ msg, args });
    }
    info(msg: string, ...args: unknown[]): void {
        this.logs.info.push({ msg, args });
    }
    warn(msg: string, ...args: unknown[]): void {
        this.logs.warn.push({ msg, args });
    }
    error(msg: string, ...args: unknown[]): void {
        this.logs.error.push({ msg, args });
    }
}

interface MockRouterOpts {
    userIndex?: Record<string, string>; // clientId -> userId
    sendBehavior?: (clientId: string, message: unknown) => boolean | Promise<boolean | void> | void;
    broadcastBehavior?: (message: unknown, excludeClientId: string) => unknown;
}

interface MockRouter extends CallMessageRouter {
    sent: Array<{ clientId: string; message: any }>;
    broadcasts: Array<{ message: any; excludeClientId: string }>;
    getClientsByUserId: jest.Mock<UserClientMatch[], [string[], string]>;
    sendToClient: jest.Mock;
    broadcastToAll: jest.Mock;
}

/**
 * Mock MessageRouter exposing ONLY the public surface CallService is
 * allowed to touch. Note the deliberate absence of `localClients` — if
 * the service regresses to grabbing the private Map, these tests break.
 */
function makeRouter(opts: MockRouterOpts = {}): MockRouter {
    const userIndex = opts.userIndex ?? {};
    const sendBehavior = opts.sendBehavior ?? (() => true);
    const broadcastBehavior = opts.broadcastBehavior ?? (() => undefined);
    const sent: Array<{ clientId: string; message: any }> = [];
    const broadcasts: Array<{ message: any; excludeClientId: string }> = [];
    const router = {
        sent,
        broadcasts,
        getClientsByUserId: jest.fn((userIds: string[], excludeClientId: string): UserClientMatch[] => {
            const out: UserClientMatch[] = [];
            const wanted = new Set(userIds);
            for (const [clientId, userId] of Object.entries(userIndex)) {
                if (clientId === excludeClientId) continue;
                if (wanted.has(userId)) out.push({ clientId, userId });
            }
            return out;
        }),
        sendToClient: jest.fn((clientId: string, message: unknown) => {
            sent.push({ clientId, message });
            return sendBehavior(clientId, message);
        }),
        broadcastToAll: jest.fn(async (message: unknown, excludeClientId: string) => {
            broadcasts.push({ message, excludeClientId });
            return broadcastBehavior(message, excludeClientId);
        }),
    };
    return router as unknown as MockRouter;
}

function makeService(
    router: MockRouter,
    logger: CallLogger = new MockLogger(),
    config: ConstructorParameters<typeof CallService>[0]['config'] = undefined,
): CallService {
    return new CallService({ messageRouter: router, logger, config });
}

// =====================================================================
// Constructor invariants
// =====================================================================
describe('CallService — constructor', () => {
    test('throws when messageRouter is missing', () => {
        expect(() => new (CallService as any)({ logger: new MockLogger() })).toThrow(/messageRouter/);
    });
    test('throws when logger is missing', () => {
        expect(() => new (CallService as any)({ messageRouter: makeRouter() })).toThrow(/logger/);
    });
    test('throws when options bag itself is missing', () => {
        expect(() => new (CallService as any)()).toThrow(/messageRouter/);
    });
});

// =====================================================================
// getClientsByUserId seam
// =====================================================================
describe('CallService — getClientsByUserId seam', () => {
    test('findClientsForUsers delegates to router.getClientsByUserId (no localClients access)', async () => {
        const router = makeRouter({ userIndex: { c1: 'u1', c2: 'u2', c3: 'u3' } });
        const svc = makeService(router);

        await svc.handleCallEvent('c1', 'invite', {
            callId: 'call-1',
            lobbyName: 'lobby-a',
            targetUserIds: ['u2', 'u3'],
        });

        expect(router.getClientsByUserId).toHaveBeenCalledWith(['u2', 'u3'], 'c1');
        expect(router.sendToClient).toHaveBeenCalledTimes(2);
        const recipients = router.sent.map((s) => s.clientId).sort();
        expect(recipients).toEqual(['c2', 'c3']);
    });

    test('returns empty when router lacks getClientsByUserId (defensive)', () => {
        const broken = { sendToClient: jest.fn(), broadcastToAll: jest.fn() } as unknown as MockRouter;
        const svc = new CallService({ messageRouter: broken, logger: new MockLogger() });
        expect(svc.findClientsForUsers(['u1'], 'c0')).toEqual([]);
    });
});

// =====================================================================
// Promise.allSettled delivery accounting
// =====================================================================
describe('CallService — Promise.allSettled delivery accounting', () => {
    test('one failing recipient does not short-circuit the rest', async () => {
        const router = makeRouter({
            userIndex: { c1: 'u1', c2: 'u2', c3: 'u3' },
            sendBehavior: (clientId) => {
                if (clientId === 'c2') throw new Error('socket gone');
                return true;
            },
        });
        const logger = new MockLogger();
        const svc = makeService(router, logger);

        await svc.handleCallEvent('c0', 'invite', {
            callId: 'call-x',
            lobbyName: 'lobby-x',
            targetUserIds: ['u1', 'u2', 'u3'],
        });

        expect(router.sendToClient).toHaveBeenCalledTimes(3);
        const warnEntry = logger.logs.warn.find((e) => /delivered/.test(e.msg));
        expect(warnEntry).toBeDefined();
        expect(warnEntry!.msg).toMatch(/2\/3 delivered/);
    });

    test('sendToClient returning false counts as a failure (closed-socket case)', async () => {
        const router = makeRouter({
            userIndex: { c1: 'u1', c2: 'u2' },
            sendBehavior: (clientId) => clientId === 'c1', // c2 returns false
        });
        const logger = new MockLogger();
        const svc = makeService(router, logger);

        await svc.handleCallEvent('c0', 'invite', {
            callId: 'call-y',
            lobbyName: 'lobby-y',
            targetUserIds: ['u1', 'u2'],
        });

        const warnEntry = logger.logs.warn.find((e) => /delivered/.test(e.msg));
        expect(warnEntry).toBeDefined();
        expect(warnEntry!.msg).toMatch(/1\/2 delivered/);
    });

    test('all recipients succeeding logs the info path with delivered=N/N', async () => {
        const router = makeRouter({ userIndex: { c1: 'u1', c2: 'u2' } });
        const logger = new MockLogger();
        const svc = makeService(router, logger);

        await svc.handleCallEvent('c0', 'invite', {
            callId: 'call-z',
            lobbyName: 'lobby-z',
            targetUserIds: ['u1', 'u2'],
        });

        const infoEntry = logger.logs.info.find((e) => /delivered=/.test(e.msg));
        expect(infoEntry).toBeDefined();
        expect(infoEntry!.msg).toMatch(/delivered=2\/2/);
        expect(logger.logs.warn).toHaveLength(0);
    });

    test('async sendToClient rejection is captured (not propagated) and reason surfaced', async () => {
        const router = makeRouter({
            userIndex: { c1: 'u1' },
            sendBehavior: () => Promise.reject(new Error('async pub failed')),
        });
        const logger = new MockLogger();
        const svc = makeService(router, logger);

        await expect(
            svc.handleCallEvent('c0', 'invite', {
                callId: 'c1',
                lobbyName: 'lob',
                targetUserIds: ['u1'],
            }),
        ).resolves.toBeUndefined();

        const warnEntry = logger.logs.warn.find((e) => /delivered/.test(e.msg));
        expect(warnEntry).toBeDefined();
        expect(warnEntry!.msg).toMatch(/0\/1 delivered/);
        const failureMeta = warnEntry!.args.find(
            (a: any) => a && Array.isArray(a.failures),
        ) as { failures: Array<{ reason: string }> } | undefined;
        expect(failureMeta).toBeDefined();
        expect(failureMeta!.failures[0].reason).toMatch(/async pub failed/);
    });
});

// =====================================================================
// recordCallAction hook
// =====================================================================
describe('CallService — recordCallAction hook (consumer-injected metrics)', () => {
    test('targeted invite fires the hook with action=invite, targetKind=targeted', async () => {
        const recordCallAction = jest.fn();
        const router = makeRouter({ userIndex: { c1: 'u1' } });
        const svc = makeService(router, new MockLogger(), { recordCallAction });

        await svc.handleCallEvent('c0', 'invite', {
            callId: 'c1',
            lobbyName: 'lob',
            targetUserIds: ['u1'],
        });

        expect(recordCallAction).toHaveBeenCalledWith('invite', 'targeted');
    });

    test('broadcast ended fires the hook with action=ended, targetKind=broadcast', async () => {
        const recordCallAction = jest.fn();
        const router = makeRouter();
        const svc = makeService(router, new MockLogger(), { recordCallAction });

        await svc.handleCallEvent('c0', 'ended', { callId: 'c1', lobbyName: 'lob' });

        expect(recordCallAction).toHaveBeenCalledWith('ended', 'broadcast');
    });

    test('a throwing hook never propagates to the caller (fail-open)', async () => {
        const recordCallAction = jest.fn(() => {
            throw new Error('sink kaboom');
        });
        const router = makeRouter({ userIndex: { c1: 'u1' } });
        const svc = makeService(router, new MockLogger(), { recordCallAction });

        await expect(
            svc.handleCallEvent('c0', 'invite', {
                callId: 'c1',
                lobbyName: 'lob',
                targetUserIds: ['u1'],
            }),
        ).resolves.toBeUndefined();

        expect(recordCallAction).toHaveBeenCalled();
    });

    test('no hook wired → no error', async () => {
        const router = makeRouter();
        const svc = makeService(router); // no config
        await expect(
            svc.handleCallEvent('c0', 'declined', { callId: 'c1', lobbyName: 'lob' }),
        ).resolves.toBeUndefined();
    });
});

// =====================================================================
// authorize hook
// =====================================================================
describe('CallService — authorize hook (replaces enforceChannelPermission)', () => {
    test('denial sends an error frame and skips routing', async () => {
        const router = makeRouter({ userIndex: { c1: 'u1' } });
        const svc = makeService(router, new MockLogger(), {
            authorize: () => false,
        });

        await svc.handleAction('c0', 'invite', {
            callId: 'c1',
            lobbyName: 'lob',
            targetUserIds: ['u1'],
        });

        // Only the error frame back to c0 — no recipient frames went out.
        expect(router.sendToClient).toHaveBeenCalledTimes(1);
        expect(router.sendToClient).toHaveBeenCalledWith(
            'c0',
            expect.objectContaining({ type: 'error', service: 'call' }),
        );
        expect(router.broadcastToAll).not.toHaveBeenCalled();
        expect(router.getClientsByUserId).not.toHaveBeenCalled();
    });

    test('authorize receives clientId + action + payload', async () => {
        const router = makeRouter();
        const authorize = jest.fn(() => true);
        const svc = makeService(router, new MockLogger(), { authorize });

        await svc.handleAction('c0', 'cancelled', { callId: 'c1', lobbyName: 'lob' });

        expect(authorize).toHaveBeenCalledWith(
            'c0',
            'cancelled',
            expect.objectContaining({ callId: 'c1', lobbyName: 'lob' }),
        );
    });

    test('default allow-all when no authorize provided', async () => {
        const router = makeRouter();
        const svc = makeService(router);
        await svc.handleAction('c0', 'ended', { callId: 'c1', lobbyName: 'lob' });
        expect(router.broadcastToAll).toHaveBeenCalledTimes(1);
    });
});

// =====================================================================
// Passthrough behaviors preserved from gateway
// =====================================================================
describe('CallService — passthrough behaviors preserved', () => {
    test('invite without callId/lobbyName sends an error frame to the sender', async () => {
        const router = makeRouter();
        const svc = makeService(router);
        await svc.handleAction('c0', 'invite', {});
        expect(router.sendToClient).toHaveBeenCalledWith(
            'c0',
            expect.objectContaining({ type: 'error', service: 'call' }),
        );
    });

    test('unknown action triggers an error frame', async () => {
        const router = makeRouter();
        const svc = makeService(router);
        await svc.handleAction('c0', 'mystery', {});
        expect(router.sendToClient).toHaveBeenCalledWith(
            'c0',
            expect.objectContaining({ type: 'error', message: expect.stringContaining('mystery') }),
        );
    });

    test('legacy targetUserId is coerced into a single-element targetUserIds', async () => {
        const router = makeRouter({ userIndex: { c1: 'u1', c2: 'u2' } });
        const svc = makeService(router);
        await svc.handleCallEvent('c0', 'declined', { targetUserId: 'u1' });
        expect(router.getClientsByUserId).toHaveBeenCalledWith(['u1'], 'c0');
    });

    test('empty targetUserIds path falls through to broadcastToAll (sender excluded)', async () => {
        const router = makeRouter();
        const svc = makeService(router);
        await svc.handleCallEvent('c0', 'cancelled', { callId: 'c1', lobbyName: 'lob' });
        expect(router.broadcastToAll).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'call', action: 'cancelled' }),
            'c0',
        );
    });
});

// =====================================================================
// ALLOWED_CALL_ACTIONS validation
// =====================================================================
describe('CallService — ALLOWED_CALL_ACTIONS validation', () => {
    test.each([
        ['unknown verb', 'ringing'],
        ['empty string', ''],
        ['wrong case', 'Invite'],
        ['random token', 'foobar'],
    ])('rejects %s ("%s") with an error frame and never routes', async (_label, action) => {
        const router = makeRouter({ userIndex: { c1: 'u1' } });
        const svc = makeService(router);

        await svc.handleAction('c0', action, { callId: 'c1', lobbyName: 'lob', targetUserIds: ['u1'] });

        expect(router.sendToClient).toHaveBeenCalledTimes(1);
        expect(router.sendToClient).toHaveBeenCalledWith(
            'c0',
            expect.objectContaining({ type: 'error', service: 'call' }),
        );
        expect(router.broadcastToAll).not.toHaveBeenCalled();
        expect(router.getClientsByUserId).not.toHaveBeenCalled();
    });

    test('null action is rejected (defensive — no String coercion)', async () => {
        const router = makeRouter();
        const svc = makeService(router);
        await svc.handleAction('c0', null as unknown as string, {});
        expect(router.sendToClient).toHaveBeenCalledWith(
            'c0',
            expect.objectContaining({ type: 'error' }),
        );
        expect(router.broadcastToAll).not.toHaveBeenCalled();
    });

    test.each<CallAction>(['invite', 'accepted', 'declined', 'cancelled', 'ended'])(
        'accepts allowed action "%s" without error',
        async (action) => {
            const router = makeRouter({ userIndex: { c1: 'u1' } });
            const svc = makeService(router);
            await svc.handleAction('c0', action, {
                callId: 'c1',
                lobbyName: 'lob',
                targetUserIds: ['u1'],
            });
            const errorFrames = router.sent.filter((s) => s.message && s.message.type === 'error');
            expect(errorFrames).toHaveLength(0);
        },
    );
});

// =====================================================================
// Invite required-field validation
// =====================================================================
describe('CallService — invite required-field validation', () => {
    test('invite missing callId only is rejected', async () => {
        const router = makeRouter({ userIndex: { c1: 'u1' } });
        const svc = makeService(router);
        await svc.handleCallEvent('c0', 'invite', { lobbyName: 'lob', targetUserIds: ['u1'] });

        expect(router.sendToClient).toHaveBeenCalledTimes(1);
        expect(router.sendToClient).toHaveBeenCalledWith(
            'c0',
            expect.objectContaining({
                type: 'error',
                service: 'call',
                message: expect.stringMatching(/callId.*lobbyName/),
            }),
        );
    });

    test('invite missing lobbyName only is rejected', async () => {
        const router = makeRouter({ userIndex: { c1: 'u1' } });
        const svc = makeService(router);
        await svc.handleCallEvent('c0', 'invite', { callId: 'c1', targetUserIds: ['u1'] });
        expect(router.sendToClient).toHaveBeenCalledWith(
            'c0',
            expect.objectContaining({ type: 'error', service: 'call' }),
        );
    });

    test('non-invite actions do NOT require callId/lobbyName', async () => {
        const router = makeRouter({ userIndex: { c1: 'u1' } });
        const svc = makeService(router);
        await svc.handleCallEvent('c0', 'declined', { targetUserIds: ['u1'] });

        const errorFrames = router.sent.filter((s) => s.message && s.message.type === 'error');
        expect(errorFrames).toHaveLength(0);
        expect(router.sendToClient).toHaveBeenCalledWith(
            'c1',
            expect.objectContaining({ type: 'call', action: 'declined' }),
        );
    });
});

// =====================================================================
// Target shape variants
// =====================================================================
describe('CallService — target shape variants', () => {
    test('singular legacy targetUserId actually delivers (1:1 call shape)', async () => {
        const router = makeRouter({ userIndex: { c1: 'u1', c2: 'u2' } });
        const svc = makeService(router);

        await svc.handleCallEvent('c0', 'invite', {
            callId: 'call-1to1',
            lobbyName: 'lob',
            targetUserId: 'u2',
        });

        expect(router.getClientsByUserId).toHaveBeenCalledWith(['u2'], 'c0');
        expect(router.sendToClient).toHaveBeenCalledTimes(1);
        expect(router.sent[0].clientId).toBe('c2');
        expect(router.sent[0].message).toMatchObject({
            type: 'call',
            action: 'invite',
            data: expect.objectContaining({ callId: 'call-1to1', lobbyName: 'lob' }),
        });
        expect(router.broadcastToAll).not.toHaveBeenCalled();
    });

    test('plural targetUserIds with N entries delivers to N tabs (group call)', async () => {
        const router = makeRouter({
            userIndex: { c1: 'u1', c2: 'u2', c3: 'u3', c4: 'u4' },
        });
        const svc = makeService(router);

        await svc.handleCallEvent('c0', 'invite', {
            callId: 'call-group',
            lobbyName: 'lob',
            targetUserIds: ['u2', 'u3', 'u4'],
        });

        expect(router.sendToClient).toHaveBeenCalledTimes(3);
        expect(router.sent.map((s) => s.clientId).sort()).toEqual(['c2', 'c3', 'c4']);
        expect(router.broadcastToAll).not.toHaveBeenCalled();
    });

    test('mixed shape (singular + plural) is merged and deduped', async () => {
        const router = makeRouter({
            userIndex: { c1: 'u1', c2: 'u2', c3: 'u3' },
        });
        const svc = makeService(router);

        await svc.handleCallEvent('c0', 'invite', {
            callId: 'call-mix',
            lobbyName: 'lob',
            targetUserIds: ['u2', 'u3'],
            targetUserId: 'u2',
        });

        const [argUserIds] = router.getClientsByUserId.mock.calls[0];
        expect([...argUserIds].sort()).toEqual(['u2', 'u3']);
        expect(router.sendToClient).toHaveBeenCalledTimes(2);
    });

    test('targetUserIds with non-string entries are filtered out', async () => {
        const router = makeRouter({ userIndex: { c1: 'u1', c2: 'u2' } });
        const svc = makeService(router);

        await svc.handleCallEvent('c0', 'invite', {
            callId: 'c1',
            lobbyName: 'lob',
            targetUserIds: ['u2', null as any, undefined as any, 42 as any, '', 'u1'],
        });

        const [argUserIds] = router.getClientsByUserId.mock.calls[0];
        expect(argUserIds.sort()).toEqual(['u1', 'u2']);
    });
});

// =====================================================================
// Broadcast routing
// =====================================================================
describe('CallService — broadcast routing', () => {
    test('truly empty payload broadcasts and never resolves users', async () => {
        const router = makeRouter({ userIndex: { c1: 'u1', c2: 'u2' } });
        const svc = makeService(router);

        await svc.handleCallEvent('c0', 'cancelled', {});

        expect(router.broadcastToAll).toHaveBeenCalledTimes(1);
        expect(router.getClientsByUserId).not.toHaveBeenCalled();
        expect(router.sendToClient).not.toHaveBeenCalled();
    });

    test('broadcast envelope includes the sender-exclusion clientId', async () => {
        const router = makeRouter();
        const svc = makeService(router);

        await svc.handleCallEvent('sender-X', 'ended', { callId: 'c1', lobbyName: 'lob' });

        expect(router.broadcasts).toHaveLength(1);
        expect(router.broadcasts[0].excludeClientId).toBe('sender-X');
        expect(router.broadcasts[0].message).toMatchObject({
            type: 'call',
            action: 'ended',
        });
    });

    test('targetUserIds = [] (explicit empty array) falls through to broadcast', async () => {
        const router = makeRouter({ userIndex: { c1: 'u1' } });
        const svc = makeService(router);

        await svc.handleCallEvent('c0', 'cancelled', {
            callId: 'c1',
            lobbyName: 'lob',
            targetUserIds: [],
        });

        expect(router.broadcastToAll).toHaveBeenCalledTimes(1);
        expect(router.sendToClient).not.toHaveBeenCalled();
    });
});

// =====================================================================
// Sender exclusion / multi-tab semantics
// =====================================================================
describe('CallService — sender exclusion / multi-tab semantics', () => {
    test("sender's own tab is excluded; other tabs of same userId still receive", async () => {
        const router = makeRouter({
            userIndex: {
                'cSelf-A': 'u-self',
                'cSelf-B': 'u-self',
                'c-other': 'u-other',
            },
        });
        const svc = makeService(router);

        await svc.handleCallEvent('cSelf-A', 'invite', {
            callId: 'call-multitab',
            lobbyName: 'lob',
            targetUserIds: ['u-self', 'u-other'],
        });

        const recipientIds = router.sent.map((s) => s.clientId);
        expect(recipientIds).not.toContain('cSelf-A');
        expect(recipientIds).toContain('cSelf-B');
        expect(recipientIds).toContain('c-other');
        expect(router.sendToClient).toHaveBeenCalledTimes(2);
        expect(router.getClientsByUserId).toHaveBeenCalledWith(
            ['u-self', 'u-other'],
            'cSelf-A',
        );
    });

    test('single-tab user calling themselves resolves to zero recipients', async () => {
        const router = makeRouter({ userIndex: { cSelf: 'u-self' } });
        const logger = new MockLogger();
        const svc = makeService(router, logger);

        await svc.handleCallEvent('cSelf', 'invite', {
            callId: 'call-solo',
            lobbyName: 'lob',
            targetUserIds: ['u-self'],
        });

        expect(router.sendToClient).not.toHaveBeenCalled();
        const infoEntry = logger.logs.info.find((e) => /delivered=0\/0/.test(e.msg));
        expect(infoEntry).toBeDefined();
    });
});

// =====================================================================
// Per-action propagation shapes
// =====================================================================
describe('CallService — per-action propagation shapes', () => {
    test('decline reaches only the original inviter when targeted at them', async () => {
        const router = makeRouter({
            userIndex: { cA: 'u-A', cB: 'u-B', cC: 'u-C' },
        });
        const svc = makeService(router);

        await svc.handleCallEvent('cB', 'declined', {
            callId: 'call-decline',
            lobbyName: 'lob',
            targetUserId: 'u-A',
        });

        expect(router.sendToClient).toHaveBeenCalledTimes(1);
        expect(router.sent[0].clientId).toBe('cA');
        expect(router.sent[0].message).toMatchObject({
            type: 'call',
            action: 'declined',
        });
        expect(router.broadcastToAll).not.toHaveBeenCalled();
    });

    test('end propagates to every participant via broadcast (sender excluded)', async () => {
        const router = makeRouter({
            userIndex: { cA: 'u-A', cB: 'u-B', cC: 'u-C' },
        });
        const svc = makeService(router);

        await svc.handleCallEvent('cA', 'ended', { callId: 'call-end', lobbyName: 'lob' });

        expect(router.broadcastToAll).toHaveBeenCalledTimes(1);
        const [envelope, excludeClientId] = router.broadcastToAll.mock.calls[0];
        expect(envelope).toMatchObject({ type: 'call', action: 'ended' });
        expect(excludeClientId).toBe('cA');
        expect(router.sendToClient).not.toHaveBeenCalled();
    });

    test('accepted with targetUserIds delivers to inviter only', async () => {
        const router = makeRouter({
            userIndex: { cInviter: 'u-A', cAccepter: 'u-B', cBystander: 'u-C' },
        });
        const svc = makeService(router);

        await svc.handleCallEvent('cAccepter', 'accepted', {
            callId: 'c1',
            lobbyName: 'lob',
            targetUserIds: ['u-A'],
        });

        expect(router.sendToClient).toHaveBeenCalledTimes(1);
        expect(router.sent[0].clientId).toBe('cInviter');
        expect(router.sent[0].message).toMatchObject({ type: 'call', action: 'accepted' });
    });
});

// =====================================================================
// No matching recipients / outer catch
// =====================================================================
describe('CallService — no matching recipients + outer catch', () => {
    test('targeted invite where no userIds resolve does not crash and logs cleanly', async () => {
        const router = makeRouter({ userIndex: { c1: 'u1' } });
        const logger = new MockLogger();
        const svc = makeService(router, logger);

        await expect(
            svc.handleCallEvent('c0', 'invite', {
                callId: 'call-ghost',
                lobbyName: 'lob',
                targetUserIds: ['nobody-home'],
            }),
        ).resolves.toBeUndefined();

        expect(router.sendToClient).not.toHaveBeenCalled();
        expect(router.broadcastToAll).not.toHaveBeenCalled();
        expect(logger.logs.error).toHaveLength(0);
        expect(logger.logs.info.some((e) => /delivered=0\/0/.test(e.msg))).toBe(true);
    });

    test('handleAction outer catch: broadcastToAll throw → logger.error + Internal server error frame', async () => {
        const router = makeRouter({
            userIndex: { c1: 'u1' },
            broadcastBehavior: () => {
                throw new Error('redis down');
            },
        });
        const logger = new MockLogger();
        const svc = makeService(router, logger);

        await svc.handleAction('c1', 'invite', { callId: 'c1', lobbyName: 'lob' });

        expect(logger.logs.error.length).toBeGreaterThan(0);
        const errored = logger.logs.error.find((e) => /Error handling call action/.test(e.msg));
        expect(errored).toBeDefined();
        const errFrames = router.sent.filter(
            (s) => s.clientId === 'c1' && s.message.type === 'error',
        );
        expect(errFrames.length).toBe(1);
        expect(errFrames[0].message.message).toBe('Internal server error');
        expect(errFrames[0].message.service).toBe('call');
    });
});

// =====================================================================
// getStats / defensive fallbacks
// =====================================================================
describe('CallService — getStats + defensive fallbacks', () => {
    test('getStats returns the stateless marker', () => {
        const svc = makeService(makeRouter());
        expect(svc.getStats()).toEqual({ stateful: false });
    });

    test('handleCallEvent tolerates null data payload (payload || {} fallback)', async () => {
        const router = makeRouter();
        const svc = makeService(router);
        await svc.handleCallEvent('c1', 'ended', null);
        expect(router.broadcasts.length).toBe(1);
    });

    test('broadcast info log substitutes "-" for missing callId/lobbyName (?? fallback)', async () => {
        const router = makeRouter();
        const logger = new MockLogger();
        const svc = makeService(router, logger);
        await svc.handleCallEvent('c1', 'ended', {});
        const info = logger.logs.info.find((e) => /broadcast call event 'ended'/.test(e.msg));
        expect(info).toBeDefined();
        expect(info!.msg).toContain('callId=-');
        expect(info!.msg).toContain('lobby=-');
    });

    test('targeted-delivery warn log: missing callId/lobbyName fall back to "-" and non-Error reject is stringified', async () => {
        const router = makeRouter({
            userIndex: { c1: 'u1' },
            sendBehavior: () => {
                // Throw a non-Error so result.reason has no .message and falls to String(reason).
                throw 'plain string failure';
            },
        });
        const logger = new MockLogger();
        const svc = makeService(router, logger);

        await svc.handleCallEvent('c0', 'ended', { targetUserIds: ['u1'] });

        const warnEntry = logger.logs.warn.find((e) => /delivered/.test(e.msg));
        expect(warnEntry).toBeDefined();
        expect(warnEntry!.msg).toContain('callId=-');
        expect(warnEntry!.msg).toContain('lobby=-');
        const failureMeta = warnEntry!.args.find(
            (a: any) => a && Array.isArray(a.failures),
        ) as { failures: Array<{ reason: string }> } | undefined;
        expect(failureMeta).toBeDefined();
        expect(failureMeta!.failures[0].reason).toBe('plain string failure');
    });

    test('handleDisconnect is a no-op (stateless)', async () => {
        const router = makeRouter();
        const svc = makeService(router);
        await expect(svc.handleDisconnect('whoever')).resolves.toBeUndefined();
    });
});

// =====================================================================
// Envelope shape integrity
// =====================================================================
describe('CallService — envelope shape integrity', () => {
    test('every routed envelope carries type/action/data/timestamp', async () => {
        const router = makeRouter({ userIndex: { c1: 'u1' } });
        const svc = makeService(router);
        await svc.handleCallEvent('c0', 'invite', {
            callId: 'c1',
            lobbyName: 'lob',
            targetUserIds: ['u1'],
            extraField: 'preserved',
        });
        expect(router.sent[0].message).toMatchObject({
            type: 'call',
            action: 'invite',
            data: expect.objectContaining({
                callId: 'c1',
                lobbyName: 'lob',
                extraField: 'preserved',
            }),
            timestamp: expect.any(String),
        });
        expect(Number.isFinite(Date.parse(router.sent[0].message.timestamp))).toBe(true);
    });
});
