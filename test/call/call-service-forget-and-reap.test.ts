// UX audit 2026-08-24 — stale resumable calls must be killable.
//
// Two mechanisms under test:
//
//   1. `forget` verb — a client durably dismisses a resumable call:
//      its userId → callId resume index entry (and invite-registry
//      entry) is removed server-side, so the ResumeCallDialog cannot
//      resurrect in a fresh session. Sender-scoped: peers keep theirs.
//
//   2. status-query reaping — when a `status` query proves that every
//      registered participant of an indexed call is dead
//      (isClientLive === false for all), the call is reaped from the
//      lobby + user discovery indexes instead of haunting them for the
//      4h TTL. Cross-node safety: liveness `null` (unknown) counts as
//      alive and must NOT reap.

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

function makeRouter(
  userByClient: Record<string, string>,
  isClientLive?: (clientId: string) => boolean | null,
) {
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
    ...(isClientLive ? { isClientLive } : {}),
  } as any;
  return router;
}

const users = { 'c-alice': 'u-alice', 'c-bob': 'u-bob', 'c-zed': 'u-zed' };

async function establishedCall(
  router: ReturnType<typeof makeRouter>,
  store: InMemoryCallStateStore,
): Promise<CallService> {
  const svc = new CallService({
    messageRouter: router,
    logger: new NoopLogger() as any,
    stateStore: store,
  });
  await svc.handleCallEvent('c-alice', 'invite', {
    callId: 'call-1', lobbyName: 'dm:u-alice:u-bob', callerId: 'u-alice',
    callerName: 'Alice', targetUserIds: ['u-bob'],
  });
  await svc.handleCallEvent('c-bob', 'accepted', {
    callId: 'call-1', lobbyName: 'dm:u-alice:u-bob', callerId: 'u-alice',
    targetUserIds: ['u-alice'],
  });
  router.sent.length = 0;
  return svc;
}

describe('CallService — forget verb (durable resume dismissal)', () => {
  test('forget clears ONLY the sender\'s user index and acks with forgotten', async () => {
    const store = new InMemoryCallStateStore();
    const router = makeRouter(users);
    const svc = await establishedCall(router, store);

    // Both sides are resume-indexed after invite+accept.
    expect(await store.getCallIdsByUser('u-alice')).toContain('call-1');
    expect(await store.getCallIdsByUser('u-bob')).toContain('call-1');

    // Bob dismisses — through handleAction so the ALLOWED_CALL_ACTIONS
    // gate is part of the regression surface.
    await svc.handleAction('c-bob', 'forget', { callId: 'call-1' });

    expect(await store.getCallIdsByUser('u-bob')).toEqual([]);
    // Alice's resume entry is untouched — dismissal is per-user.
    expect(await store.getCallIdsByUser('u-alice')).toContain('call-1');

    const acks = router.sent.filter((s) => s.clientId === 'c-bob');
    expect(acks).toHaveLength(1);
    expect(acks[0]!.message.action).toBe('forgotten');
    expect(acks[0]!.message.data).toMatchObject({ callId: 'call-1', forgotten: true });
    // Nothing broadcast to anyone else.
    expect(router.sent.filter((s) => s.clientId !== 'c-bob')).toHaveLength(0);
    await svc.dispose();
  });

  test('forget without callId errors to sender', async () => {
    const store = new InMemoryCallStateStore();
    const router = makeRouter(users);
    const svc = await establishedCall(router, store);
    await svc.handleAction('c-bob', 'forget', {});
    expect(router.sent).toHaveLength(1);
    expect(router.sent[0]!.clientId).toBe('c-bob');
    expect(router.sent[0]!.message.type).toBe('error');
    await svc.dispose();
  });
});

describe('CallService — status query reaps provably-dead calls', () => {
  test('all participants dead-local → active:false AND lobby/user indexes cleared', async () => {
    const store = new InMemoryCallStateStore();
    // Every client is provably dead (crashed tabs).
    const router = makeRouter(users, () => false);
    const svc = await establishedCall(router, store);

    // Sanity: the stale state IS indexed before the query.
    expect(await store.getCallIdsByLobby('dm:u-alice:u-bob')).toContain('call-1');
    expect(await store.getCallIdsByUser('u-alice')).toContain('call-1');

    await svc.handleAction('c-zed', 'status', { lobbyName: 'dm:u-alice:u-bob' });

    const reply = router.sent.find((s) => s.clientId === 'c-zed');
    expect(reply!.message.action).toBe('active-call');
    expect(reply!.message.data.active).toBe(false);

    // The reap: discovery indexes are gone, so the resume dialog can
    // never resurrect this call in a fresh session.
    expect(await store.getCallIdsByLobby('dm:u-alice:u-bob')).toEqual([]);
    expect(await store.getCallIdsByUser('u-alice')).toEqual([]);
    expect(await store.getCallIdsByUser('u-bob')).toEqual([]);
    await svc.dispose();
  });

  test('liveness UNKNOWN (null, cross-node) → still active, nothing reaped', async () => {
    const store = new InMemoryCallStateStore();
    const router = makeRouter(users, () => null);
    const svc = await establishedCall(router, store);

    await svc.handleAction('c-zed', 'status', { lobbyName: 'dm:u-alice:u-bob' });

    const reply = router.sent.find((s) => s.clientId === 'c-zed');
    expect(reply!.message.data.active).toBe(true);
    expect(await store.getCallIdsByLobby('dm:u-alice:u-bob')).toContain('call-1');
    expect(await store.getCallIdsByUser('u-bob')).toContain('call-1');
    await svc.dispose();
  });

  test('store-only dead call (local cache cold) is reaped too', async () => {
    const store = new InMemoryCallStateStore();
    // Simulate a call registered by a previous process: only the durable
    // store knows it; this node's activeCalls map is empty.
    await store.registerParticipant('call-9', 'c-ghost', 'u-alice', 'dm:u-alice:u-bob', ['u-bob']);
    await store.registerLobbyCall!('dm:u-alice:u-bob', 'call-9', 3600);
    await store.registerUserCall!('u-alice', 'call-9', 3600);
    await store.registerUserCall!('u-bob', 'call-9', 3600);

    const router = makeRouter(users, (cid) => (cid === 'c-ghost' ? false : true));
    const svc = new CallService({
      messageRouter: router,
      logger: new NoopLogger() as any,
      stateStore: store,
    });

    await svc.handleAction('c-zed', 'status', { lobbyName: 'dm:u-alice:u-bob' });

    const reply = router.sent.find((s) => s.clientId === 'c-zed');
    expect(reply!.message.data.active).toBe(false);
    expect(await store.getCallIdsByLobby('dm:u-alice:u-bob')).toEqual([]);
    expect(await store.getCallIdsByUser('u-alice')).toEqual([]);
    expect(await store.getCallIdsByUser('u-bob')).toEqual([]);
    await svc.dispose();
  });
});
