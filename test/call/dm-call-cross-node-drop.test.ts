// A DM call's drop, told to the other person exactly once and by name, on one
// replica or two (realtime-examples chat call shelf audit, C3, 2026-09-29).
//
// Live on two gateway pods: carol (pod B) dropped hard; hank (pod A) got
// `user-status {status: 'left', userId: null}` with no `rejoinGraceMs` — the
// receiving replica's generic notice, since B held no local state for the
// call — and 30 s later `ended {reason: 'peer-disconnected'}`. A client can do
// nothing with an anonymous departure (the shelf ignores it and keeps carol's
// tile), and the end reads as a drop, not the grace running out. On one pod
// hank got the named notice AND the anonymous one: the origin's own
// cross-node subscription notified the peer a second time.

import { makeCluster, flush, sleep } from './helpers/cluster';

const GRACE = 60;
const lobbyName = 'dm:u-carol:u-hank';

async function dmCall(c: ReturnType<typeof makeCluster>, carolNode: 'A' | 'B') {
  c.connect('a-hank', 'u-hank', 'A');
  c.connect('x-carol', 'u-carol', carolNode);
  const carolSvc = carolNode === 'A' ? c.A.svc : c.B.svc;
  await c.A.svc.handleCallEvent('a-hank', 'invite', {
    callId: 'dm1', lobbyName, callerId: 'u-hank', callerName: 'Hank', targetUserIds: ['u-carol'],
  });
  await flush();
  await carolSvc.handleCallEvent('x-carol', 'accepted', {
    callId: 'dm1', lobbyName, callerId: 'u-carol', targetUserIds: ['u-hank'],
  });
  await flush();
  await c.A.svc.handleCallEvent('a-hank', 'user-status', { callerId: 'u-hank', userId: 'u-hank', callId: 'dm1', lobbyName, inCall: true });
  await carolSvc.handleCallEvent('x-carol', 'user-status', { callerId: 'u-carol', userId: 'u-carol', callId: 'dm1', lobbyName, inCall: true });
  await flush();
  // What the live two-pod run also did before the drop (C3 steps 4–5).
  await c.A.svc.handleCallEvent('a-hank', 'participant-state', { callId: 'dm1', lobbyName, callerId: 'u-hank', userId: 'u-hank', audioOn: true, cameraOn: true, screenSharing: false, status: 'in-call' });
  await carolSvc.handleCallEvent('x-carol', 'participant-state', { callId: 'dm1', lobbyName, callerId: 'u-carol', userId: 'u-carol', audioOn: false, cameraOn: true, screenSharing: false, status: 'in-call' });
  await c.A.svc.handleCallEvent('a-hank', 'status', { lobbyName });
  await carolSvc.handleCallEvent('x-carol', 'status', { lobbyName });
  await flush();
  c.wire.length = 0;
  return carolSvc;
}

const lefts = (c: ReturnType<typeof makeCluster>) => c.frames('a-hank', 'user-status').filter((m) => m.data?.status === 'left');

describe.each([
  ['two replicas (carol on B)', 'B' as const, undefined],
  ['two replicas, pub/sub delivered after the origin moved on', 'B' as const, 5],
  ['one replica', 'A' as const, undefined],
])('DM call drop — %s', (_label, carolNode, busDelayMs) => {
  test('the survivor hears it once, by name, with the grace; then the grace-expired end once', async () => {
    const c = makeCluster({ rejoinGraceMs: GRACE, busDelayMs });
    const carolSvc = await dmCall(c, carolNode);

    // The gateway runs the service's disconnect while it still knows the socket's user.
    await carolSvc.handleDisconnect('x-carol');
    c.drop('x-carol');
    await sleep(15); await flush(12);

    const l = lefts(c);
    expect(l).toHaveLength(1);
    expect(l[0].data).toMatchObject({ callId: 'dm1', lobbyName, userId: 'u-carol', reason: 'peer-disconnected', rejoinGraceMs: GRACE });

    await sleep(GRACE + 40);
    await sleep(15); await flush(12);
    const ended = c.frames('a-hank', 'ended');
    expect(ended).toHaveLength(1);
    expect(ended[0].data).toMatchObject({ callId: 'dm1', reason: 'rejoin-grace-expired' });
    await c.dispose();
  });

  test('back inside the grace: no end', async () => {
    const c = makeCluster({ rejoinGraceMs: GRACE, busDelayMs });
    const carolSvc = await dmCall(c, carolNode);
    await carolSvc.handleDisconnect('x-carol');
    c.drop('x-carol');
    await sleep(15); await flush(12);
    c.connect('x-carol2', 'u-carol', carolNode);
    await carolSvc.handleCallEvent('x-carol2', 'accepted', { callId: 'dm1', lobbyName, callerId: 'u-carol', targetUserIds: ['u-hank'] });
    await sleep(15); await flush(12);
    await sleep(GRACE + 40);
    await sleep(15); await flush(12);
    expect(c.frames('a-hank', 'ended')).toHaveLength(0);

    // …and gone for good the second time: the grace runs out and the call ends.
    await carolSvc.handleDisconnect('x-carol2');
    c.drop('x-carol2');
    await sleep(15); await flush(12);
    await sleep(GRACE + 40);
    await sleep(15); await flush(12);
    const ended = c.frames('a-hank', 'ended');
    expect(ended).toHaveLength(1);
    expect(ended[0].data).toMatchObject({ callId: 'dm1', reason: 'rejoin-grace-expired' });
    await c.dispose();
  });
});

// The grace-expiry end is published just before the origin forgets the call,
// store included. A receiver whose replica holds no local copy and reads the
// store after that finds nobody to tell — so the origin sends the roster it
// read (0.98.2).
test('grace-expiry end reaches a survivor whose replica has no local copy of the call', async () => {
  const c = makeCluster({ rejoinGraceMs: GRACE, busDelayMs: 5 });
  const carolSvc = await dmCall(c, 'B');
  (c.A.svc as any).activeCalls.clear();
  (c.A.svc as any).clientToCalls.clear();
  await carolSvc.handleDisconnect('x-carol');
  c.drop('x-carol');
  await sleep(15); await flush(12);
  expect(lefts(c)).toHaveLength(1);
  await sleep(GRACE + 40);
  await flush(12);
  const ended = c.frames('a-hank', 'ended');
  expect(ended).toHaveLength(1);
  expect(ended[0].data).toMatchObject({ callId: 'dm1', reason: 'rejoin-grace-expired' });
  await c.dispose();
});

// Live (two pods, 2026-09-29): the caller's replica never hears a cross-node
// accept in its own memory. Its invite sweep, 60 s after the ring, asked "did
// anyone answer?" of its local state and the store roster — and while the
// callee was away in the rejoin grace the roster held only the caller, so the
// ANSWERED call was forgotten as `no-answer`: its record deleted, the grace
// end with nobody to tell, the survivor never got `ended`.
test("the caller's replica does not end an answered call as unanswered while the callee is in the grace", async () => {
  const c = makeCluster({ rejoinGraceMs: 5_000, leader: 'A' });
  const carolSvc = await dmCall(c, 'B');
  await carolSvc.handleDisconnect('x-carol');
  c.drop('x-carol');
  await flush(12);
  await c.A.svc.runInviteSweep(Date.now() + 61_000);
  await flush(12);
  // Still one call, answered, with the caller in it.
  const view = await (c.A.svc as any).stateStore.getCall('dm1');
  expect(view?.participantClientIds).toContain('a-hank');
  expect(c.frames('a-hank', 'ended')).toHaveLength(0);
  await c.dispose();
});
