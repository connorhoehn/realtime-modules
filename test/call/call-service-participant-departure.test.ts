// F1 regression (2026-08-21): handleDisconnect used to broadcast a synthetic
// `ended` and forgetCall() the WHOLE call for every disconnect — in a
// 3-person call the first person to drop (or refresh) deleted server state
// for everyone and kicked every surviving peer. Departure is now
// participant-grain: the call survives while >=2 participants remain
// (survivors get `user-status: left`); it ends (synthetic `ended` +
// forgetCall) only when the departure leaves <=1.

import { CallService } from '../../src/call/CallService';
import type { CallMessageRouter } from '../../src/call/types';

class NoopLogger {
  debug() {/* noop */}
  info() {/* noop */}
  warn() {/* noop */}
  error() {/* noop */}
}

interface Sent { clientId: string; message: any }

function makeRouter(userByClient: Record<string, string>) {
  const sent: Sent[] = [];
  const router: CallMessageRouter & { sent: Sent[] } = {
    sent,
    sendToClient(clientId: string, message: any) {
      sent.push({ clientId, message });
      return true;
    },
    broadcastToAll() { return undefined; },
    getClientsByUserId(userIds: string[]) {
      const out: Array<{ clientId: string; userId: string }> = [];
      for (const [cid, uid] of Object.entries(userByClient)) {
        if (userIds.includes(uid)) out.push({ clientId: cid, userId: uid });
      }
      return out;
    },
    getUserIdForClient(clientId: string) {
      return userByClient[clientId] ?? null;
    },
  } as any;
  return router;
}

async function threePersonCall(router: ReturnType<typeof makeRouter>) {
  // rejoinGraceMs: 0 → legacy immediate-teardown semantics; the grace
  // behavior has its own suite below.
  const svc = new CallService({ messageRouter: router, logger: new NoopLogger() as any, rejoinGraceMs: 0 });
  await svc.handleCallEvent('c-alice', 'invite', {
    callId: 'call-1', lobbyName: 'global-hangout', callerId: 'u-alice',
    targetUserIds: ['u-bob', 'u-carol'],
  });
  await svc.handleCallEvent('c-bob', 'accepted', {
    callId: 'call-1', lobbyName: 'global-hangout', callerId: 'u-alice',
    targetUserIds: ['u-alice'],
  });
  await svc.handleCallEvent('c-carol', 'accepted', {
    callId: 'call-1', lobbyName: 'global-hangout', callerId: 'u-alice',
    targetUserIds: ['u-alice'],
  });
  router.sent.length = 0;
  return svc;
}

describe('CallService — participant-grain departure (F1)', () => {
  const users = { 'c-alice': 'u-alice', 'c-bob': 'u-bob', 'c-carol': 'u-carol' };

  test('3-person call survives one disconnect: survivors get user-status left, not ended', async () => {
    const router = makeRouter(users);
    const svc = await threePersonCall(router);

    await svc.handleDisconnect('c-bob');

    const toSurvivors = router.sent.filter((s) => s.clientId !== 'c-bob');
    const endeds = toSurvivors.filter((s) => s.message?.action === 'ended');
    const lefts = toSurvivors.filter(
      (s) => s.message?.action === 'user-status' && s.message?.data?.status === 'left',
    );
    expect(endeds).toHaveLength(0);
    expect(lefts.map((s) => s.clientId).sort()).toEqual(['c-alice', 'c-carol']);
    expect(lefts[0]!.message.data.callId).toBe('call-1');
    expect(lefts[0]!.message.data.userId).toBe('u-bob');

    // The call is still live server-side: a later clean 'ended' from carol
    // must still find state and notify alice.
    router.sent.length = 0;
    await svc.handleDisconnect('c-carol');
    const aliceFrames = router.sent.filter((s) => s.clientId === 'c-alice');
    expect(aliceFrames.some((s) => s.message?.action === 'ended')).toBe(true);
    await svc.dispose();
  });

  test('2-person call still ends on disconnect (legacy UX preserved)', async () => {
    const router = makeRouter(users);
    const svc = new CallService({ messageRouter: router, logger: new NoopLogger() as any, rejoinGraceMs: 0 });
    await svc.handleCallEvent('c-alice', 'invite', {
      callId: 'call-2', lobbyName: 'dm:u-alice:u-bob', callerId: 'u-alice',
      targetUserIds: ['u-bob'],
    });
    await svc.handleCallEvent('c-bob', 'accepted', {
      callId: 'call-2', lobbyName: 'dm:u-alice:u-bob', callerId: 'u-alice',
      targetUserIds: ['u-alice'],
    });
    router.sent.length = 0;

    await svc.handleDisconnect('c-bob');

    const aliceFrames = router.sent.filter((s) => s.clientId === 'c-alice');
    expect(aliceFrames.some((s) => s.message?.action === 'ended')).toBe(true);
    expect(aliceFrames.some((s) => s.message?.action === 'user-status')).toBe(false);
    await svc.dispose();
  });
});

describe('CallService — nested envelope tolerance', () => {
  test('invite with payload nested under data still registers and routes', async () => {
    const router = makeRouter({ 'c-hank': 'u-hank', 'c-bob': 'u-bob' });
    const svc = new CallService({ messageRouter: router, logger: new NoopLogger() as any });
    await svc.handleCallEvent('c-hank', 'invite', {
      data: {
        callId: 'nested-1', lobbyName: 'dm:u-hank:u-bob', callerId: 'u-hank',
        targetUserIds: ['u-bob'],
      },
    } as any);
    const invites = router.sent.filter(
      (s) => s.clientId === 'c-bob' && s.message?.action === 'invite',
    );
    expect(invites).toHaveLength(1);
    expect(invites[0]!.message.data.callId).toBe('nested-1');
    await svc.dispose();
  });
});


describe('CallService — rejoin grace (F2, 2026-08-22)', () => {
  const users = { 'c-alice': 'u-alice', 'c-bob': 'u-bob', 'c-bob2': 'u-bob' };

  async function twoPersonCall(router: ReturnType<typeof makeRouter>, graceMs: number) {
    const svc = new CallService({
      messageRouter: router, logger: new NoopLogger() as any, rejoinGraceMs: graceMs,
    });
    await svc.handleCallEvent('c-alice', 'invite', {
      callId: 'call-g', lobbyName: 'dm:u-alice:u-bob', callerId: 'u-alice',
      targetUserIds: ['u-bob'],
    });
    await svc.handleCallEvent('c-bob', 'accepted', {
      callId: 'call-g', lobbyName: 'dm:u-alice:u-bob', callerId: 'u-alice',
      targetUserIds: ['u-alice'],
    });
    router.sent.length = 0;
    return svc;
  }

  test('2-person disconnect defers the end: survivor gets user-status left with rejoinGraceMs', async () => {
    const router = makeRouter(users);
    const svc = await twoPersonCall(router, 60_000);

    await svc.handleDisconnect('c-bob');

    const aliceFrames = router.sent.filter((s) => s.clientId === 'c-alice');
    expect(aliceFrames.some((s) => s.message?.action === 'ended')).toBe(false);
    const left = aliceFrames.find((s) => s.message?.action === 'user-status');
    expect(left).toBeDefined();
    expect(left!.message.data.status).toBe('left');
    expect(left!.message.data.rejoinGraceMs).toBe(60_000);
    await svc.dispose();
  });

  test('grace expiry with no rejoin ends the call', async () => {
    jest.useFakeTimers();
    try {
      const router = makeRouter(users);
      const svc = await twoPersonCall(router, 5_000);
      await svc.handleDisconnect('c-bob');
      router.sent.length = 0;

      await jest.advanceTimersByTimeAsync(5_100);

      const aliceFrames = router.sent.filter((s) => s.clientId === 'c-alice');
      expect(aliceFrames.some(
        (s) => s.message?.action === 'ended' && s.message?.data?.reason === 'rejoin-grace-expired',
      )).toBe(true);
      await svc.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  test('re-registration within grace cancels the deferred end', async () => {
    jest.useFakeTimers();
    try {
      const router = makeRouter(users);
      const svc = await twoPersonCall(router, 5_000);
      await svc.handleDisconnect('c-bob');
      router.sent.length = 0;

      // Bob's refreshed tab rejoins (new clientId, same user).
      await svc.handleCallEvent('c-bob2', 'accepted', {
        callId: 'call-g', lobbyName: 'dm:u-alice:u-bob', callerId: 'u-alice',
        targetUserIds: ['u-alice'],
      });
      await jest.advanceTimersByTimeAsync(10_000);

      const endeds = router.sent.filter((s) => s.message?.action === 'ended');
      expect(endeds).toHaveLength(0);
      await svc.dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});
