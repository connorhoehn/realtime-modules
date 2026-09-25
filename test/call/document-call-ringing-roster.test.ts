// Lane D/E live capture (2026-09-25): Alice, still ringing, saw "1 person in
// the call" although Frank and Bob had joined. Her only `status` came right
// after the ring — before anyone accepted — and no roster frame ever reaches
// someone who is not in the call. The server now pushes `active-call` to
// ringing invitees on every roster change. This runs the real frame sequence
// (hook shapes, the gateway's anti-spoofing authorize) on two replicas.

import { makeCluster, flush, type Directory } from './helpers/cluster';

const DOC = '3a6e5bd5-feff-46ad-9ced-41c7315b1974';
const CALL = '42ce7d0f-ba24-4bdb-a0b3-8a4898298e68';

function authorize(dirRef: { dir: Directory | null }) {
  return (clientId: string, _a: string, data: { callerId?: unknown }) => {
    const declared = typeof data?.callerId === 'string' ? data.callerId : null;
    return !declared || dirRef.dir!.get(clientId)?.userId === declared;
  };
}

const accepted = (user: string) => ({ callId: CALL, lobbyName: DOC, targetUserIds: ['dev-connor'], userId: user, displayName: user });
const state = (user: string) => ({ callId: CALL, lobbyName: DOC, callerId: user, userId: user, displayName: user, audioOn: true, cameraOn: true, screenSharing: false, status: 'in-call' });
const roster = (c: ReturnType<typeof makeCluster>, cid: string) =>
  c.frames(cid, 'active-call').filter((d) => d.data.callId === CALL).map((d) => [...d.data.participantUserIds].sort());

it('a ringing invitee sees each join and leave as it happens, across replicas', async () => {
  const ref: { dir: Directory | null } = { dir: null };
  const c = makeCluster({ rejoinGraceMs: 0, config: { authorize: authorize(ref) } });
  ref.dir = c.dir;
  c.connect('a-connor', 'dev-connor', 'A');
  c.connect('b-alice', 'dev-alice', 'B');
  c.connect('a-frank', 'dev-frank', 'A');
  c.connect('b-bob', 'dev-bob', 'B');

  // Connor: start() → invite + participant-state.
  await c.A.svc.handleCallEvent('a-connor', 'invite', {
    callId: CALL, lobbyName: DOC, targetUserIds: ['dev-alice', 'dev-frank', 'dev-bob'], callerId: 'dev-connor', callerName: 'Connor Hoehn',
    kind: 'document-review', documentId: DOC, title: 'Auth architecture review', documentIds: [DOC], media: 'video', participantCount: 1,
  });
  await c.A.svc.handleCallEvent('a-connor', 'participant-state', state('dev-connor'));
  // Alice's hook asks right after the ring.
  await c.B.svc.handleCallEvent('b-alice', 'status', { lobbyName: DOC });
  await flush();
  expect(roster(c, 'b-alice').pop()).toEqual(['dev-connor']);

  // Frank joins on A: accepted, participant-state, meta.
  await c.A.svc.handleCallEvent('a-frank', 'accepted', accepted('dev-frank'));
  await c.A.svc.handleCallEvent('a-frank', 'participant-state', state('dev-frank'));
  await c.A.svc.handleCallEvent('a-frank', 'meta', { callId: CALL });
  await flush();
  expect(roster(c, 'b-alice').pop()).toEqual(['dev-connor', 'dev-frank']);
  expect(roster(c, 'b-bob').pop()).toEqual(['dev-connor', 'dev-frank']); // Bob is still ringing too

  // Bob joins on B.
  await c.B.svc.handleCallEvent('b-bob', 'accepted', accepted('dev-bob'));
  await c.B.svc.handleCallEvent('b-bob', 'participant-state', state('dev-bob'));
  await flush();
  expect(roster(c, 'b-alice').pop()).toEqual(['dev-bob', 'dev-connor', 'dev-frank']);
  const bobPushes = roster(c, 'b-bob').length;

  // Mic toggles do not re-push an unchanged roster.
  const before = roster(c, 'b-alice').length;
  await c.A.svc.handleCallEvent('a-frank', 'participant-state', { ...state('dev-frank'), audioOn: false });
  await flush();
  expect(roster(c, 'b-alice').length).toBe(before);

  // Frank leaves (hook shape: no foreign callerId).
  await c.A.svc.handleCallEvent('a-frank', 'ended', { callId: CALL, lobbyName: DOC, userId: 'dev-frank' });
  await flush();
  expect(roster(c, 'b-alice').pop()).toEqual(['dev-bob', 'dev-connor']);
  // Bob is in the call now — he is not rung, so not pushed to.
  expect(roster(c, 'b-bob').length).toBe(bobPushes);
  await c.dispose();
});
