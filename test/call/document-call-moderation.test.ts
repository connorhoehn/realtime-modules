// Host moderation on document calls: mute-participant, remove-participant,
// transfer-host — host-only, across two replicas sharing Redis.

import { RedisDocumentCallMetaStore } from '../../src/call/CallStateStore';
import { makeCluster, flush } from './helpers/cluster';

const invite = (targets: string[]) => ({
  callId: 'd1', lobbyName: 'doc-auth', callerId: 'u-host', callerName: 'Connor', targetUserIds: targets,
  kind: 'document-review', documentId: 'doc-auth', title: 'Auth architecture review',
  documentIds: ['doc-auth', 'doc-migration'], media: 'video',
});

/** Host on A; Alice (two tabs) and Frank on B; Eve on A is not in the call. */
async function call() {
  const c = makeCluster({ rejoinGraceMs: 0 });
  c.connect('a-host', 'u-host', 'A');
  c.connect('b-alice', 'u-alice', 'B');
  c.connect('b-alice-2', 'u-alice', 'B');
  c.connect('b-frank', 'u-frank', 'B');
  c.connect('a-eve', 'u-eve', 'A');
  await c.A.svc.handleCallEvent('a-host', 'invite', invite(['u-alice', 'u-frank']));
  await c.B.svc.handleCallEvent('b-alice', 'accepted', { callId: 'd1', targetUserIds: ['u-host'] });
  await c.B.svc.handleCallEvent('b-frank', 'accepted', { callId: 'd1', targetUserIds: ['u-host'] });
  await flush();
  c.wire.length = 0;
  return { c, meta: new RedisDocumentCallMetaStore(c.redis as any) };
}
const errors = (c: ReturnType<typeof makeCluster>, cid: string) =>
  c.wire.filter((w) => w.clientId === cid && w.message.type === 'error').map((w) => w.message.message);

describe('host moderation', () => {
  it('only the host may moderate, and only people in the call', async () => {
    const { c } = await call();
    for (const action of ['mute-participant', 'remove-participant', 'transfer-host'] as const) {
      await c.B.svc.handleCallEvent('b-frank', action, { callId: 'd1', userId: 'u-alice' });
    }
    expect(errors(c, 'b-frank')).toHaveLength(3);
    expect(errors(c, 'b-frank')[0]).toMatch(/Only the host/);
    await c.A.svc.handleCallEvent('a-host', 'mute-participant', { callId: 'd1', userId: 'u-eve' });
    expect(errors(c, 'a-host')[0]).toMatch(/not in call/);
    await c.A.svc.handleCallEvent('a-host', 'remove-participant', { callId: 'd1', userId: 'u-host' });
    expect(errors(c, 'a-host')[1]).toMatch(/themself/);
    expect(c.frames('b-alice')).toHaveLength(0);
    await c.dispose();
  });

  // 0.146.0: host powers come from the socket's authenticated user. They used
  // to fall back to `payload.userId`, so a socket with no identity naming the
  // host could end the call for everyone.
  it('host powers ignore payload.userId from a non-host socket', async () => {
    const { c, meta } = await call();
    // x-ghost has no identity on either node; b-frank is a seated non-host.
    for (const [node, cid] of [['A', 'x-ghost'], ['B', 'b-frank']] as const) {
      const svc = node === 'A' ? c.A.svc : c.B.svc;
      for (const action of ['mute-participant', 'remove-participant', 'transfer-host'] as const) {
        await svc.handleCallEvent(cid, action, { callId: 'd1', userId: 'u-host', callerId: 'u-host' } as any);
        await svc.handleCallEvent(cid, action, { callId: 'd1', userId: 'u-alice', callerId: 'u-host' } as any);
      }
      await svc.handleCallEvent(cid, 'ended', { callId: 'd1', userId: 'u-host', callerId: 'u-host', forEveryone: true } as any);
    }
    await flush();
    // (x-ghost is unknown to the test router, so its refusals are not recorded; the effects below are what matter.)
    expect(errors(c, 'b-frank').length).toBeGreaterThanOrEqual(7);
    for (const cid of ['b-alice', 'b-alice-2', 'a-host']) {
      for (const verb of ['mute-participant', 'remove-participant', 'ended']) expect(c.frames(cid, verb)).toHaveLength(0);
    }
    const after = await meta.get('d1');
    expect(after?.hostUserId).toBe('u-host');
    expect(after?.invites['u-alice']?.state).toBe('accepted');
    await c.dispose();
  });

  it('mute reaches every tab of the target on the other node, and nobody else', async () => {
    const { c } = await call();
    await c.A.svc.handleCallEvent('a-host', 'mute-participant', { callId: 'd1', userId: 'u-alice' });
    await flush();
    for (const cid of ['b-alice', 'b-alice-2']) {
      expect(c.frames(cid, 'mute-participant')[0].data).toEqual({ callId: 'd1', userId: 'u-alice', by: 'u-host' });
    }
    expect(c.frames('b-frank', 'mute-participant')).toHaveLength(0);
    await c.dispose();
  });

  it('remove: target told, everyone else gets left + call-meta, both nodes drop the connections, no way back without an invite', async () => {
    const { c, meta } = await call();
    await c.B.svc.handleCallEvent('b-alice', 'present', { callId: 'd1', documentId: 'doc-auth' });
    c.wire.length = 0;
    await c.A.svc.handleCallEvent('a-host', 'remove-participant', { callId: 'd1', userId: 'u-alice' });
    await flush();
    expect(c.frames('b-alice', 'remove-participant')[0].data).toMatchObject({ userId: 'u-alice', by: 'u-host' });
    expect(c.frames('b-alice-2', 'remove-participant')).toHaveLength(1);
    for (const cid of ['a-host', 'b-frank']) {
      expect(c.frames(cid, 'user-status')[0].data).toMatchObject({ userId: 'u-alice', status: 'left', reason: 'removed' });
      const m = c.frames(cid, 'call-meta').pop().data;
      expect(m.invites['u-alice'].state).toBe('removed');
      expect(m.presenting).toBeNull();
    }
    expect(c.frames('b-alice', 'call-meta')).toHaveLength(0);
    const stored = await meta.get('d1');
    expect(Object.values(stored!.clients ?? {})).not.toContain('u-alice');

    // Later call-wide frames skip her, on either node.
    c.wire.length = 0;
    await c.B.svc.handleCallEvent('b-frank', 'participant-state', { callId: 'd1', status: 'in-call', audioOn: false });
    await flush();
    expect(c.frames('b-alice')).toHaveLength(0);
    expect(c.frames('a-host', 'participant-state')).toHaveLength(1);

    // She cannot slip back in…
    await c.B.svc.handleCallEvent('b-alice', 'accepted', { callId: 'd1', targetUserIds: ['u-host'] });
    await c.B.svc.handleCallEvent('b-alice', 'meta', { callId: 'd1' });
    expect(errors(c, 'b-alice')[0]).toMatch(/removed/);
    expect(errors(c, 'b-alice')[1]).toMatch(/Not a participant/);
    // …until the host invites her again.
    await c.A.svc.handleCallEvent('a-host', 'invite', invite(['u-alice']));
    await c.B.svc.handleCallEvent('b-alice', 'accepted', { callId: 'd1', targetUserIds: ['u-host'] });
    expect((await meta.get('d1'))!.invites['u-alice'].state).toBe('accepted');
    await c.dispose();
  });

  it('transfer-host moves the role; the new host can moderate, the old one cannot, and stays in the call', async () => {
    const { c, meta } = await call();
    await c.A.svc.handleCallEvent('a-host', 'transfer-host', { callId: 'd1', userId: 'u-frank' });
    await flush();
    for (const cid of ['a-host', 'b-alice', 'b-frank']) expect(c.frames(cid, 'call-meta').pop().data.hostUserId).toBe('u-frank');
    const m = await meta.get('d1');
    expect(m!.hostUserId).toBe('u-frank');
    expect(m!.invites['u-host'].state).toBe('accepted');

    await c.A.svc.handleCallEvent('a-host', 'set-title', { callId: 'd1', title: 'Nope' });
    expect(errors(c, 'a-host')[0]).toMatch(/Only the host/);
    await c.B.svc.handleCallEvent('b-frank', 'mute-participant', { callId: 'd1', userId: 'u-host' });
    await flush();
    expect(c.frames('a-host', 'mute-participant')).toHaveLength(1);
    // Old host still a participant.
    await c.A.svc.handleCallEvent('a-host', 'meta', { callId: 'd1' });
    expect(c.frames('a-host', 'call-meta').pop().data.hostUserId).toBe('u-frank');
    await c.dispose();
  });
});
