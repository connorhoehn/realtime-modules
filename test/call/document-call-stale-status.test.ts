// Lane C, "stale call id": `status` must not answer with a call whose state is
// gone cluster-wide, and must prefer the newest live document call.

import { makeCluster, flush } from './helpers/cluster';

const invite = (callId: string, callerClient: string) => ({
  callId, lobbyName: 'doc-auth', callerId: callerClient === 'a-host' ? 'u-host' : 'u-host2', targetUserIds: ['u-alice'],
  kind: 'document-review', documentId: 'doc-auth', title: `Call ${callId}`, documentIds: ['doc-auth'], media: 'video',
});

async function callA(c: ReturnType<typeof makeCluster>) {
  c.connect('a-host', 'u-host', 'A');
  c.connect('b-alice', 'u-alice', 'B');
  await c.A.svc.handleCallEvent('a-host', 'invite', invite('call-A', 'a-host'));
  await c.B.svc.handleCallEvent('b-alice', 'accepted', { callId: 'call-A', targetUserIds: ['u-host'] });
  await flush();
}

async function callB(c: ReturnType<typeof makeCluster>) {
  // New tabs, on both replicas.
  c.connect('b-host2', 'u-host2', 'B');
  c.connect('a-alice2', 'u-alice', 'A');
  await c.B.svc.handleCallEvent('b-host2', 'invite', invite('call-B', 'b-host2'));
  await c.A.svc.handleCallEvent('a-alice2', 'accepted', { callId: 'call-B', targetUserIds: ['u-host2'] });
  await flush();
}

async function statusFrom(c: ReturnType<typeof makeCluster>, node: 'A' | 'B') {
  const asker = node === 'A' ? 'a-eve' : 'b-eve';
  c.connect(asker, 'u-eve', node);
  c.wire.length = 0;
  await c[node].svc.handleCallEvent(asker, 'status', { lobbyName: 'doc-auth' });
  await flush();
  return c.frames(asker, 'active-call')[0].data;
}

/** What lane E's resetDocumentCall does: DEL call:*<id>*, call:user:* — not the lobby index, not gateway memory. */
function simulateReset(c: ReturnType<typeof makeCluster>, callId: string) {
  const r = c.redis;
  for (const k of [...r.hashes.keys()]) if (k.startsWith('call:') && k.includes(callId)) r.hashes.delete(k);
  for (const k of [...r.sets.keys()]) if ((k.startsWith('call:') && k.includes(callId)) || k.startsWith('call:user:')) r.sets.delete(k);
  for (const k of [...r.strings.keys()]) if (k.startsWith('call:') && k.includes(callId)) r.strings.delete(k);
}

describe('status after a reset (two replicas)', () => {
  it('answers with the new call B, not the deleted call A, on either node', async () => {
    const c = makeCluster({ rejoinGraceMs: 0 });
    await callA(c);
    simulateReset(c, 'call-A');
    expect(c.redis.sets.get('call:lobby:doc-auth')?.has('call-A')).toBe(true); // reset left the index
    await callB(c);
    // Starting B pruned the dead entry from the lobby index.
    expect(c.redis.sets.get('call:lobby:doc-auth')?.has('call-A')).toBe(false);
    for (const node of ['A', 'B'] as const) {
      const r = await statusFrom(c, node);
      expect(r).toMatchObject({ active: true, callId: 'call-B' });
      expect([...r.participantUserIds].sort()).toEqual(['u-alice', 'u-host2']);
      expect(r.participantCount).toBe(2);
    }
    // Both nodes forgot A from memory as well.
    expect(c.A.svc.getStats().activeCalls).toBe(1);
    expect(c.B.svc.getStats().activeCalls).toBe(1);
    await c.dispose();
  });

  it('with A and B both live, answers with the newer B', async () => {
    const c = makeCluster({ rejoinGraceMs: 0 });
    await callA(c);
    await new Promise((r) => setTimeout(r, 5));
    await callB(c);
    for (const node of ['A', 'B'] as const) {
      expect(await statusFrom(c, node)).toMatchObject({ active: true, callId: 'call-B' });
    }
    await c.dispose();
  });

  it('a call whose remote participants are dead (their replica is gone) is not offered', async () => {
    const dead = new Set<string>();
    const c = makeCluster({ rejoinGraceMs: 0, isClientAlive: (cid: string) => !dead.has(cid) });
    await callA(c);
    // A's host tab closes on A without a disconnect ever reaching the call…
    c.drop('a-host');
    dead.add('a-host');
    // …and replica B (Alice) dies.
    dead.add('b-alice');
    const r = await statusFrom(c, 'A');
    expect(r.active).toBe(false);
    await c.dispose();
  });
});
