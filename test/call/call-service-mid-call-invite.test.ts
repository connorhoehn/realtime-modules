// Mid-call invite (2026-08-23): pulling a third person into a call that
// is already running.
//
// The client reuses the EXISTING callId on purpose — that's what makes
// the invitee land in this call's lobby instead of starting a rival one.
// The 5s invite dedup was keyed on callId alone, so any mid-call invite
// issued inside that window was suppressed server-side and the caller
// got no error, no ring, and no clue why.
//
// Dedup identity is now (callId, audience): re-firing the same invite at
// the same people is still a duplicate; ringing someone NEW never is.

import { CallService, inviteDedupKey } from '../../src/call/CallService';
import type { CallMessageRouter } from '../../src/call/types';

class NoopLogger {
  debug() {/* noop */}
  info() {/* noop */}
  warn() {/* noop */}
  error() {/* noop */}
}

interface Sent { clientId: string; message: any }

const users: Record<string, string> = {
  'c-alice': 'u-alice',
  'c-bob': 'u-bob',
  'c-carol': 'u-carol',
};

function makeRouter() {
  const sent: Sent[] = [];
  return {
    sent,
    sendToClient(clientId: string, message: any) {
      sent.push({ clientId, message });
      return true;
    },
    broadcastToAll() { return undefined; },
    getClientsByUserId(userIds: string[]) {
      return Object.entries(users)
        .filter(([, uid]) => userIds.includes(uid))
        .map(([clientId, userId]) => ({ clientId, userId }));
    },
    getUserIdForClient(clientId: string) {
      return users[clientId] ?? null;
    },
  } as CallMessageRouter & { sent: Sent[] };
}

function invitesTo(router: ReturnType<typeof makeRouter>, clientId: string) {
  return router.sent.filter(
    (s) => s.clientId === clientId && s.message?.action === 'invite',
  );
}

describe('CallService — mid-call invite', () => {
  it('rings a new person on an existing callId inside the dedup window', async () => {
    const router = makeRouter();
    const svc = new CallService({ messageRouter: router, logger: new NoopLogger() as any });

    // Alice rings Bob; they are on call-1 together.
    await svc.handleCallEvent('c-alice', 'invite', {
      callId: 'call-1', lobbyName: 'global-hangout', callerId: 'u-alice',
      callerName: 'Alice', targetUserIds: ['u-bob'],
    });
    expect(invitesTo(router, 'c-bob')).toHaveLength(1);

    // Immediately (well inside the 5s window) Alice adds Carol to the
    // SAME call. Carol must ring.
    await svc.handleCallEvent('c-alice', 'invite', {
      callId: 'call-1', lobbyName: 'global-hangout', callerId: 'u-alice',
      callerName: 'Alice', targetUserIds: ['u-carol'],
    });

    const carolInvites = invitesTo(router, 'c-carol');
    expect(carolInvites).toHaveLength(1);
    // Same call, same lobby — that's what puts her in this SFU channel.
    expect(carolInvites[0].message.data?.callId ?? carolInvites[0].message.callId)
      .toBe('call-1');
    // And Bob is not re-rung for a call he's already on.
    expect(invitesTo(router, 'c-bob')).toHaveLength(1);
  });

  it('still suppresses a genuine double-click at the same audience', async () => {
    const router = makeRouter();
    const svc = new CallService({ messageRouter: router, logger: new NoopLogger() as any });

    for (let i = 0; i < 3; i++) {
      await svc.handleCallEvent('c-alice', 'invite', {
        callId: 'call-2', lobbyName: 'global-hangout', callerId: 'u-alice',
        callerName: 'Alice', targetUserIds: ['u-bob'],
      });
    }
    expect(invitesTo(router, 'c-bob')).toHaveLength(1);
  });

  it('treats a re-fired broadcast invite as a duplicate', async () => {
    const router = makeRouter();
    const svc = new CallService({ messageRouter: router, logger: new NoopLogger() as any });

    await svc.handleCallEvent('c-alice', 'invite', {
      callId: 'call-3', lobbyName: 'global-hangout', callerId: 'u-alice',
      callerName: 'Alice', targetUserIds: [],
    });
    const afterFirst = router.sent.length;
    await svc.handleCallEvent('c-alice', 'invite', {
      callId: 'call-3', lobbyName: 'global-hangout', callerId: 'u-alice',
      callerName: 'Alice', targetUserIds: [],
    });
    expect(router.sent.length).toBe(afterFirst);
  });
});

describe('inviteDedupKey', () => {
  it('collapses to the bare callId for broadcasts', () => {
    expect(inviteDedupKey('call-1', [])).toBe('call-1');
  });

  it('is order-insensitive so the same audience always collides', () => {
    expect(inviteDedupKey('call-1', ['u-b', 'u-a']))
      .toBe(inviteDedupKey('call-1', ['u-a', 'u-b']));
  });

  it('separates different audiences on the same call', () => {
    expect(inviteDedupKey('call-1', ['u-a']))
      .not.toBe(inviteDedupKey('call-1', ['u-b']));
  });
});
