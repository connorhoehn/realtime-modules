// `status` → `active-call` for a document call, asked by someone not in it:
// participantUserIds must name the people actually in the call on every
// replica (not "caller + every invitee"), and participantCount counts people.

import { makeCluster, flush } from './helpers/cluster';

it('names the people in a document call across replicas, counting people not tabs', async () => {
  const c = makeCluster({ rejoinGraceMs: 0 });
  c.connect('a-host', 'u-host', 'A');
  c.connect('b-alice', 'u-alice', 'B');
  c.connect('b-alice-2', 'u-alice', 'B');
  c.connect('b-frank', 'u-frank', 'B');
  c.connect('b-bob', 'u-bob', 'B');
  c.connect('a-eve', 'u-eve', 'A');
  await c.A.svc.handleCallEvent('a-host', 'invite', {
    callId: 'd1', lobbyName: 'doc-auth', callerId: 'u-host', targetUserIds: ['u-alice', 'u-frank', 'u-bob'],
    kind: 'document-review', documentId: 'doc-auth', title: 'Auth architecture review', documentIds: ['doc-auth'], media: 'video',
  });
  await c.B.svc.handleCallEvent('b-alice', 'accepted', { callId: 'd1', targetUserIds: ['u-host'] });
  await c.B.svc.handleCallEvent('b-alice-2', 'accepted', { callId: 'd1', targetUserIds: ['u-host'] });
  await c.B.svc.handleCallEvent('b-frank', 'accepted', { callId: 'd1', targetUserIds: ['u-host'] });
  await flush();

  // Eve (not in the call) asks on A, where Alice's and Frank's sockets are unknown.
  await c.A.svc.handleCallEvent('a-eve', 'status', { lobbyName: 'doc-auth' });
  await flush();
  const reply = c.frames('a-eve', 'active-call')[0].data;
  expect(reply.active).toBe(true);
  expect(reply.callId).toBe('d1');
  expect([...reply.participantUserIds].sort()).toEqual(['u-alice', 'u-frank', 'u-host']); // not u-bob (still ringing)
  expect(reply.participantCount).toBe(3);
  await c.dispose();
});
