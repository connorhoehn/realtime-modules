// Document-call actions (meta / set-documents / present / set-title), their
// authorization, leave / end-for-everyone, reconnecting, and the cross-node
// departure path with meta present.

import { RedisDocumentCallMetaStore } from '../../src/call/CallStateStore';
import { makeCluster, flush, sleep } from './helpers/cluster';

const invite = (targets: string[]) => ({
  callId: 'd1', lobbyName: 'doc-auth', callerId: 'u-host', callerName: 'Connor', targetUserIds: targets,
  kind: 'document-review', documentId: 'doc-auth', title: 'Auth architecture review',
  documentIds: ['doc-auth', 'doc-migration'], documentTitles: { 'doc-auth': 'Auth architecture', 'doc-migration': 'Migration brief' },
  media: 'video',
});

async function callWithAlice(opts: Parameters<typeof makeCluster>[0] = {}) {
  const c = makeCluster({ rejoinGraceMs: 0, ...opts });
  c.connect('a-host', 'u-host', 'A');
  c.connect('b-alice', 'u-alice', 'B');
  c.connect('a-frank', 'u-frank', 'A');
  c.connect('a-eve', 'u-eve', 'A');
  await c.A.svc.handleCallEvent('a-host', 'invite', invite(['u-alice', 'u-frank']));
  await c.B.svc.handleCallEvent('b-alice', 'accepted', { callId: 'd1', targetUserIds: ['u-host'] });
  await c.A.svc.handleCallEvent('a-frank', 'accepted', { callId: 'd1', targetUserIds: ['u-host'] });
  await flush();
  c.wire.length = 0;
  const meta = new RedisDocumentCallMetaStore(c.redis as any);
  return { c, meta };
}

const lastMeta = (c: ReturnType<typeof makeCluster>, clientId: string) => {
  const f = c.frames(clientId, 'call-meta');
  return f[f.length - 1]?.data;
};
const errors = (c: ReturnType<typeof makeCluster>, clientId: string) =>
  c.wire.filter((w) => w.clientId === clientId && w.message.type === 'error').map((w) => w.message.message);

describe('meta', () => {
  it('answers the asker only, without connection ids', async () => {
    const { c } = await callWithAlice();
    await c.B.svc.handleCallEvent('b-alice', 'meta', { callId: 'd1' });
    await flush();
    expect(c.frames('b-alice', 'call-meta')).toHaveLength(1);
    expect(c.frames('a-host', 'call-meta')).toHaveLength(0);
    const m = lastMeta(c, 'b-alice');
    expect(m).toMatchObject({ callId: 'd1', title: 'Auth architecture review', hostUserId: 'u-host', media: 'video' });
    expect(m.clients).toBeUndefined();
    expect(m.invites['u-alice'].state).toBe('accepted');
    await c.dispose();
  });

  it('refuses someone who is not in the call', async () => {
    const { c } = await callWithAlice();
    await c.A.svc.handleCallEvent('a-eve', 'meta', { callId: 'd1' });
    expect(errors(c, 'a-eve')[0]).toMatch(/Not a participant/);
    await c.dispose();
  });
});

describe('set-documents', () => {
  it('any participant may change the list; the host document stays first; everyone gets call-meta across nodes', async () => {
    const { c, meta } = await callWithAlice();
    await c.B.svc.handleCallEvent('b-alice', 'set-documents', { callId: 'd1', documentIds: ['doc-migration', 'doc-new'], documentTitles: { 'doc-new': 'Rollout' } });
    await flush();
    const m = await meta.get('d1');
    expect(m!.documentIds).toEqual(['doc-auth', 'doc-migration', 'doc-new']);
    expect(m!.documentTitles).toEqual({ 'doc-auth': 'Auth architecture', 'doc-migration': 'Migration brief', 'doc-new': 'Rollout' });
    for (const cid of ['a-host', 'b-alice', 'a-frank']) expect(lastMeta(c, cid).documentIds).toEqual(['doc-auth', 'doc-migration', 'doc-new']);
    expect(c.frames('a-eve', 'call-meta')).toHaveLength(0);
    await c.dispose();
  });
});

describe('present', () => {
  it('lets one person present, blocks others, lets the host take over', async () => {
    const { c, meta } = await callWithAlice();
    await c.B.svc.handleCallEvent('b-alice', 'present', { callId: 'd1', documentId: 'doc-auth' });
    await flush();
    expect((await meta.get('d1'))!.presenting).toMatchObject({ documentId: 'doc-auth', userId: 'u-alice' });
    expect(lastMeta(c, 'a-frank').presenting.userId).toBe('u-alice');

    await c.A.svc.handleCallEvent('a-frank', 'present', { callId: 'd1', documentId: 'doc-migration' });
    expect(errors(c, 'a-frank')[0]).toMatch(/Someone else is presenting/);
    expect((await meta.get('d1'))!.presenting!.userId).toBe('u-alice');

    await c.A.svc.handleCallEvent('a-host', 'present', { callId: 'd1', documentId: 'doc-migration' });
    await flush();
    expect((await meta.get('d1'))!.presenting).toMatchObject({ documentId: 'doc-migration', userId: 'u-host' });

    await c.A.svc.handleCallEvent('a-host', 'present', { callId: 'd1', documentId: null });
    await flush();
    expect((await meta.get('d1'))!.presenting).toBeNull();
    expect(lastMeta(c, 'b-alice').presenting).toBeNull();
    await c.dispose();
  });

  it('only a review document can be presented', async () => {
    const { c } = await callWithAlice();
    await c.B.svc.handleCallEvent('b-alice', 'present', { callId: 'd1', documentId: 'doc-elsewhere' });
    expect(errors(c, 'b-alice')[0]).toMatch(/review document/);
    await c.dispose();
  });

  it('removing the presented document from the list stops the presentation', async () => {
    const { c, meta } = await callWithAlice();
    await c.B.svc.handleCallEvent('b-alice', 'present', { callId: 'd1', documentId: 'doc-migration' });
    await c.A.svc.handleCallEvent('a-host', 'set-documents', { callId: 'd1', documentIds: ['doc-auth'] });
    expect((await meta.get('d1'))!.presenting).toBeNull();
    await c.dispose();
  });
});

describe('set-title', () => {
  it('is host only', async () => {
    const { c, meta } = await callWithAlice();
    await c.B.svc.handleCallEvent('b-alice', 'set-title', { callId: 'd1', title: 'Hijack' });
    expect(errors(c, 'b-alice')[0]).toMatch(/Only the host/);
    await c.A.svc.handleCallEvent('a-host', 'set-title', { callId: 'd1', title: '  Auth review v2 ' });
    await flush();
    expect((await meta.get('d1'))!.title).toBe('Auth review v2');
    expect(lastMeta(c, 'b-alice').title).toBe('Auth review v2');
    await c.dispose();
  });
});

describe('signalling on a document call', () => {
  it('participant-state with no targets goes to the call, never to everyone', async () => {
    const { c } = await callWithAlice();
    await c.B.svc.handleCallEvent('b-alice', 'participant-state', { callId: 'd1', lobbyName: 'doc-auth', cameraOn: false, audioOn: true, status: 'in-call' });
    await flush();
    expect(c.A.router.broadcasts).toHaveLength(0);
    expect(c.B.router.broadcasts).toHaveLength(0);
    expect(c.frames('a-host', 'participant-state')).toHaveLength(1);
    expect(c.frames('a-frank', 'participant-state')).toHaveLength(1);
    expect(c.frames('a-eve', 'participant-state')).toHaveLength(0);
    await c.dispose();
  });

  it('declined marks the invite and tells the inviter', async () => {
    const c = makeCluster({ rejoinGraceMs: 0 });
    c.connect('a-host', 'u-host', 'A'); c.connect('b-bob', 'u-bob', 'B');
    await c.A.svc.handleCallEvent('a-host', 'invite', invite(['u-bob']));
    await c.B.svc.handleCallEvent('b-bob', 'declined', { callId: 'd1', reason: 'not-now' });
    await flush();
    const meta = await new RedisDocumentCallMetaStore(c.redis as any).get('d1');
    expect(meta!.invites['u-bob'].state).toBe('declined');
    expect(c.frames('a-host', 'declined')[0].data).toMatchObject({ callId: 'd1', reason: 'not-now', userId: 'u-bob' });
    expect(c.A.svc.getStats().activeCalls).toBe(1);
    await c.dispose();
  });

  it('ended without forEveryone is one person leaving', async () => {
    const { c, meta } = await callWithAlice();
    await c.B.svc.handleCallEvent('b-alice', 'present', { callId: 'd1', documentId: 'doc-auth' });
    c.wire.length = 0;
    await c.B.svc.handleCallEvent('b-alice', 'ended', { callId: 'd1' });
    await flush();
    const left = c.frames('a-host', 'user-status');
    expect(left[0].data).toMatchObject({ userId: 'u-alice', status: 'left' });
    expect(c.frames('a-host', 'ended')).toHaveLength(0);
    expect((await meta.get('d1'))!.presenting).toBeNull();
    expect(await meta.get('d1')).not.toBeNull();
    await c.dispose();
  });

  it('end for everyone is host only and tears the call down on every node', async () => {
    const { c, meta } = await callWithAlice();
    await c.B.svc.handleCallEvent('b-alice', 'ended', { callId: 'd1', forEveryone: true });
    expect(errors(c, 'b-alice')[0]).toMatch(/Only the host/);
    await c.A.svc.handleCallEvent('a-host', 'ended', { callId: 'd1', forEveryone: true });
    await flush();
    for (const cid of ['b-alice', 'a-frank', 'a-host']) expect(c.frames(cid, 'ended')[0].data).toMatchObject({ callId: 'd1', forEveryone: true });
    expect(await meta.get('d1')).toBeNull();
    expect(c.A.svc.getStats().activeCalls).toBe(0);
    expect(c.B.svc.getStats().activeCalls).toBe(0);
    await c.dispose();
  });

  it('the last person out ends the call and deletes the meta', async () => {
    const c = makeCluster({ rejoinGraceMs: 0 });
    c.connect('a-host', 'u-host', 'A');
    await c.A.svc.handleCallEvent('a-host', 'invite', invite([]));
    await c.A.svc.handleCallEvent('a-host', 'ended', { callId: 'd1' });
    await flush();
    expect(await new RedisDocumentCallMetaStore(c.redis as any).get('d1')).toBeNull();
    await c.dispose();
  });
});

describe('disconnect and replicas', () => {
  it('a dropped socket is "reconnecting", then "left" if it does not come back — once, across nodes', async () => {
    const { c } = await callWithAlice({ rejoinGraceMs: 30 });
    c.drop('b-alice');
    await c.B.svc.handleDisconnect('b-alice');
    await flush();
    // One notice per peer, although both nodes heard about the departure.
    expect(c.frames('a-host', 'user-status').map((m) => m.data.status)).toEqual(['reconnecting']);
    expect(c.frames('a-frank', 'user-status').map((m) => m.data.status)).toEqual(['reconnecting']);
    expect(c.frames('a-host', 'user-status')[0].data).toMatchObject({ userId: 'u-alice', rejoinGraceMs: 30 });
    await sleep(60); await flush();
    expect(c.frames('a-host', 'user-status').map((m) => m.data.status)).toEqual(['reconnecting', 'left']);
    expect(c.frames('a-host', 'ended')).toHaveLength(0);
    await c.dispose();
  });

  it('coming back inside the grace (on the other node) cancels the left', async () => {
    const { c, meta } = await callWithAlice({ rejoinGraceMs: 40 });
    c.drop('b-alice');
    await c.B.svc.handleDisconnect('b-alice');
    c.connect('a-alice-2', 'u-alice', 'A');
    await c.A.svc.handleCallEvent('a-alice-2', 'participant-state', { callId: 'd1', status: 'in-call', cameraOn: true, audioOn: true });
    await c.A.svc.handleCallEvent('a-alice-2', 'meta', { callId: 'd1' });
    await sleep(70); await flush();
    expect(c.frames('a-host', 'user-status').map((m) => m.data.status)).toEqual(['reconnecting']);
    expect(c.frames('a-alice-2', 'call-meta')).toHaveLength(1);
    expect(Object.values((await meta.get('d1'))!.clients ?? {})).toContain('u-alice');
    await c.dispose();
  });

  it('a lone host refreshing keeps the call', async () => {
    const c = makeCluster({ rejoinGraceMs: 40 });
    c.connect('a-host', 'u-host', 'A');
    await c.A.svc.handleCallEvent('a-host', 'invite', invite([]));
    c.drop('a-host');
    await c.A.svc.handleDisconnect('a-host');
    c.connect('b-host-2', 'u-host', 'B');
    await c.B.svc.handleCallEvent('b-host-2', 'participant-state', { callId: 'd1', status: 'in-call' });
    await sleep(70); await flush();
    expect(await new RedisDocumentCallMetaStore(c.redis as any).get('d1')).not.toBeNull();
    await c.dispose();
  });

  it('the sweep leader prunes clients whose replica died', async () => {
    const dead = new Set<string>();
    const { c } = await callWithAlice({ isClientAlive: (cid: string) => !dead.has(cid) });
    dead.add('b-alice');
    await c.A.svc.runInviteSweep();
    await flush();
    expect(c.frames('a-host', 'user-status')[0].data).toMatchObject({ userId: 'u-alice', status: 'left', reason: 'node-lost' });
    expect(c.frames('a-frank', 'user-status')).toHaveLength(1);
    await c.dispose();
  });
});
