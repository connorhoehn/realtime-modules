// F2/F3 (2026-08-21): call discovery primitives.
//
// F3 — `status` query verb: a client that was never invited (or just
// reconnected) asks "is there an active call in lobby X?" and gets an
// `active-call` reply addressed to it alone.
//
// F2 — durable userId → callIds index: page refresh gives the tab a NEW
// clientId, so the clientId reverse-index misses and the resume dialog
// never fires. registerUserCall/getCallIdsByUser key on the stable
// userId instead.

import { CallService } from '../../src/call/CallService';
import { InMemoryCallStateStore } from '../../src/call/CallStateStore';
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

const users = {
  'c-alice': 'u-alice', 'c-bob': 'u-bob', 'c-carol': 'u-carol', 'c-zed': 'u-zed',
};

async function activeGroupCall(router: ReturnType<typeof makeRouter>, store?: InMemoryCallStateStore) {
  const svc = new CallService({
    messageRouter: router,
    logger: new NoopLogger() as any,
    ...(store ? { stateStore: store } : {}),
  });
  await svc.handleCallEvent('c-alice', 'invite', {
    callId: 'call-1', lobbyName: 'global-hangout', callerId: 'u-alice',
    callerName: 'Alice', targetUserIds: ['u-bob'],
  });
  await svc.handleCallEvent('c-bob', 'accepted', {
    callId: 'call-1', lobbyName: 'global-hangout', callerId: 'u-alice',
    targetUserIds: ['u-alice'],
  });
  router.sent.length = 0;
  return svc;
}

describe('CallService — status query (F3)', () => {
  test('non-participant gets active-call with call metadata (via handleAction gate)', async () => {
    const router = makeRouter(users);
    const svc = await activeGroupCall(router);

    // Through handleAction — the consumer entry point — so the
    // ALLOWED_CALL_ACTIONS gate is part of the regression surface
    // (the verb was initially missing from the set: handleCallEvent
    // worked in tests while every real client got 'Unknown call
    // action: status').
    await svc.handleAction('c-zed', 'status', { lobbyName: 'global-hangout' });

    const replies = router.sent.filter((s) => s.clientId === 'c-zed');
    expect(replies).toHaveLength(1);
    const msg = replies[0]!.message;
    expect(msg.action).toBe('active-call');
    expect(msg.data.active).toBe(true);
    expect(msg.data.callId).toBe('call-1');
    expect(msg.data.callerId).toBe('u-alice');
    expect(msg.data.callerName).toBe('Alice');
    expect(msg.data.participantCount).toBe(2);
    expect([...msg.data.participantUserIds].sort()).toEqual(['u-alice', 'u-bob']);
    await svc.dispose();
  });

  test('empty lobby answers active:false; nothing broadcast to others', async () => {
    const router = makeRouter(users);
    const svc = await activeGroupCall(router);

    await svc.handleCallEvent('c-zed', 'status', { lobbyName: 'some-quiet-lobby' });

    expect(router.sent.map((s) => s.clientId)).toEqual(['c-zed']);
    expect(router.sent[0]!.message.action).toBe('active-call');
    expect(router.sent[0]!.message.data).toMatchObject({ lobbyName: 'some-quiet-lobby', active: false });
    await svc.dispose();
  });

  test('status without lobbyName is an error to sender', async () => {
    const router = makeRouter(users);
    const svc = new CallService({ messageRouter: router, logger: new NoopLogger() as any });
    await svc.handleCallEvent('c-zed', 'status', {});
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!.clientId).toBe('c-zed');
    expect(router.sent[0]!.message.type).toBe('error');
    await svc.dispose();
  });

  test('ended call no longer reports active', async () => {
    const router = makeRouter(users);
    const svc = await activeGroupCall(router);
    await svc.handleCallEvent('c-alice', 'ended', {
      callId: 'call-1', lobbyName: 'global-hangout', callerId: 'u-alice',
    });
    await svc.handleCallEvent('c-bob', 'ended', {
      callId: 'call-1', lobbyName: 'global-hangout', callerId: 'u-bob',
    });
    router.sent.length = 0;

    await svc.handleCallEvent('c-zed', 'status', { lobbyName: 'global-hangout' });
    expect(router.sent[0]!.message.data.active).toBe(false);
    await svc.dispose();
  });

  test('falls back to the stateStore lobby index when local cache is cold', async () => {
    const store = new InMemoryCallStateStore();
    // Simulate a peer node's registration: this node's local cache never
    // saw the call, only the shared store did.
    await store.registerParticipant('call-9', 'c-remote', 'u-alice', 'peer-lobby', ['u-bob']);
    await store.registerLobbyCall!('peer-lobby', 'call-9', 3600);

    const router = makeRouter(users);
    const svc = new CallService({
      messageRouter: router, logger: new NoopLogger() as any, stateStore: store,
    });
    await svc.handleCallEvent('c-zed', 'status', { lobbyName: 'peer-lobby' });

    const msg = router.sent[0]!.message;
    expect(msg.data.active).toBe(true);
    expect(msg.data.callId).toBe('call-9');
    await svc.dispose();
  });
});

describe('CallStateStore — userId call index (F2)', () => {
  test('participants land in the userId index on invite and accept', async () => {
    const store = new InMemoryCallStateStore();
    const router = makeRouter(users);
    const svc = await activeGroupCall(router, store);

    expect(await store.getCallIdsByUser!('u-alice')).toEqual(['call-1']);
    expect(await store.getCallIdsByUser!('u-bob')).toEqual(['call-1']);
    // zed never joined — nothing leaks into their index.
    expect(await store.getCallIdsByUser!('u-zed')).toEqual([]);
    await svc.dispose();
  });

  test('index self-prunes entries for forgotten calls', async () => {
    const store = new InMemoryCallStateStore();
    await store.registerParticipant('call-x', 'c-1', 'u-alice', 'lobby', []);
    await store.registerUserCall!('u-alice', 'call-x', 3600);
    expect(await store.getCallIdsByUser!('u-alice')).toEqual(['call-x']);
    await store.forgetCall('call-x');
    expect(await store.getCallIdsByUser!('u-alice')).toEqual([]);
  });
});

describe('CallService — status ghost-call guard', () => {
  test('a call whose every participant is dead-local is not reported active', async () => {
    const router = makeRouter(users);
    // isClientLive: everyone dead.
    (router as any).isClientLive = () => false;
    const svc = await activeGroupCall(router);
    await svc.handleCallEvent('c-zed', 'status', { lobbyName: 'global-hangout' });
    expect(router.sent[0]!.message.data.active).toBe(false);
    await svc.dispose();
  });

  test('cross-node (unknown) participants are trusted as live', async () => {
    const router = makeRouter(users);
    (router as any).isClientLive = () => null; // unknown — trust
    const svc = await activeGroupCall(router);
    await svc.handleCallEvent('c-zed', 'status', { lobbyName: 'global-hangout' });
    expect(router.sent[0]!.message.data.active).toBe(true);
    await svc.dispose();
  });
});

// ─── J2 (2026-08-22): a clean hang-up must not leave a joinable call ────────
//
// Operator-reported: "when you close out the hangout and refresh, it still
// presents that a chat is open and you can join it." Two causes — the rejoin
// grace outlived an EXPLICIT terminal verb, and forgetCall left the call in
// the F2/F3 discovery indexes.

describe('CallService — terminal verbs beat the rejoin grace (J2)', () => {
  const users = { 'c-alice': 'u-alice', 'c-bob': 'u-bob' };

  async function twoPersonCall(router: ReturnType<typeof makeRouter>, store?: InMemoryCallStateStore) {
    const svc = new CallService({
      messageRouter: router,
      logger: new NoopLogger() as any,
      rejoinGraceMs: 30_000,
      ...(store ? { stateStore: store } : {}),
    });
    await svc.handleCallEvent('c-alice', 'invite', {
      callId: 'call-j2', lobbyName: 'global-hangout', callerId: 'u-alice',
      targetUserIds: ['u-bob'],
    });
    await svc.handleCallEvent('c-bob', 'accepted', {
      callId: 'call-j2', lobbyName: 'global-hangout', callerId: 'u-alice',
      targetUserIds: ['u-alice'],
    });
    router.sent.length = 0;
    return svc;
  }

  test('hanging up cancels a pending grace — status goes inactive immediately', async () => {
    const router = makeRouter(users);
    const svc = await twoPersonCall(router);

    // Bob's tab drops (refresh-shaped) → call enters the rejoin grace.
    await svc.handleDisconnect('c-bob');
    router.sent.length = 0;
    await svc.handleAction('c-alice', 'status', { lobbyName: 'global-hangout' });
    expect(router.sent[0]!.message.data.active).toBe(true); // grace holding it

    // Alice then hangs up explicitly. That is a decision, not a hiccup.
    await svc.handleCallEvent('c-alice', 'ended', {
      callId: 'call-j2', lobbyName: 'global-hangout', callerId: 'u-alice',
    });
    router.sent.length = 0;

    await svc.handleAction('c-alice', 'status', { lobbyName: 'global-hangout' });
    expect(router.sent[0]!.message.data.active).toBe(false);
    await svc.dispose();
  });

  test('forgetCall evicts the call from the lobby and user indexes', async () => {
    const store = new InMemoryCallStateStore();
    const router = makeRouter(users);
    const svc = await twoPersonCall(router, store);

    expect(await store.getCallIdsByLobby!('global-hangout')).toContain('call-j2');
    expect(await store.getCallIdsByUser!('u-alice')).toContain('call-j2');

    // Both sides hang up — the last one forgets the call.
    await svc.handleCallEvent('c-alice', 'ended', {
      callId: 'call-j2', lobbyName: 'global-hangout', callerId: 'u-alice',
    });
    await svc.handleCallEvent('c-bob', 'ended', {
      callId: 'call-j2', lobbyName: 'global-hangout', callerId: 'u-bob',
    });

    expect(await store.getCallIdsByLobby!('global-hangout')).not.toContain('call-j2');
    expect(await store.getCallIdsByUser!('u-alice')).not.toContain('call-j2');
    await svc.dispose();
  });
});
