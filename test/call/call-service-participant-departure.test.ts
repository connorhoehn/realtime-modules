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
  const svc = new CallService({ messageRouter: router, logger: new NoopLogger() as any });
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
    const svc = new CallService({ messageRouter: router, logger: new NoopLogger() as any });
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
