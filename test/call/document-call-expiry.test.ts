// Per-target ring expiry (document calls, 2026-09-24).
//
// Before: the sweep forgot the WHOLE call once `inviteExpiresAt` passed, so
// one unanswered invitee (or an unanswered mid-call invite) ended the call
// for everyone. Now expiry is per target and an answered call is never
// forgotten by the sweep.

import { CallService } from '../../src/call/CallService';
import { InMemoryDocumentCallMetaStore } from '../../src/call/CallStateStore';
import { makeCluster, flush, NoopLogger, makeNodeRouter, type Directory, type Sent } from './helpers/cluster';

const TTL = 60_000;

function singleNode(extra: Record<string, unknown> = {}) {
  const dir: Directory = new Map();
  const wire: Sent[] = [];
  const router = makeNodeRouter('A', dir, wire);
  const svc = new CallService({ messageRouter: router, logger: new NoopLogger() as any, rejoinGraceMs: 0, ...extra });
  return { dir, wire, router, svc, connect: (c: string, u: string) => dir.set(c, { userId: u, node: 'A' }) };
}

describe('legacy calls — per-target expiry', () => {
  it('keeps an answered group call when the other invitee never answers', async () => {
    const n = singleNode();
    n.connect('c-host', 'u-host'); n.connect('c-alice', 'u-alice'); n.connect('c-bob', 'u-bob');
    await n.svc.handleCallEvent('c-host', 'invite', { callId: 'k1', lobbyName: 'room:x', callerId: 'u-host', targetUserIds: ['u-alice', 'u-bob'] });
    await n.svc.handleCallEvent('c-alice', 'accepted', { callId: 'k1', callerId: 'u-host', targetUserIds: ['u-host'] });
    await n.svc.runInviteSweep(Date.now() + TTL + 1);
    expect(n.svc.getStats().activeCalls).toBe(1);
    await n.svc.dispose();
  });

  it('keeps the call when a mid-call invite goes unanswered', async () => {
    const n = singleNode();
    n.connect('c-host', 'u-host'); n.connect('c-alice', 'u-alice'); n.connect('c-carol', 'u-carol');
    await n.svc.handleCallEvent('c-host', 'invite', { callId: 'k2', lobbyName: 'room:x', callerId: 'u-host', targetUserIds: ['u-alice'] });
    await n.svc.handleCallEvent('c-alice', 'accepted', { callId: 'k2', callerId: 'u-host', targetUserIds: ['u-host'] });
    await n.svc.handleCallEvent('c-alice', 'invite', { callId: 'k2', lobbyName: 'room:x', callerId: 'u-alice', targetUserIds: ['u-carol'] });
    await n.svc.runInviteSweep(Date.now() + TTL + 1);
    expect(n.svc.getStats().activeCalls).toBe(1);
    await n.svc.dispose();
  });

  it('still ends an unanswered 1:1 ring (a missed call)', async () => {
    const n = singleNode();
    n.connect('c-host', 'u-host'); n.connect('c-alice', 'u-alice');
    await n.svc.handleCallEvent('c-host', 'invite', { callId: 'k3', lobbyName: 'dm:x', callerId: 'u-host', targetUserIds: ['u-alice'] });
    await n.svc.runInviteSweep(Date.now() + TTL + 1);
    expect(n.svc.getStats().activeCalls).toBe(0);
    await n.svc.dispose();
  });
});

describe('document calls — per-target expiry', () => {
  const invite = (targets: string[], extra: Record<string, unknown> = {}) => ({
    callId: 'd1', lobbyName: 'doc-auth', callerId: 'u-host', callerName: 'Connor', targetUserIds: targets,
    kind: 'document-review', documentId: 'doc-auth', title: 'Auth architecture review',
    documentIds: ['doc-auth', 'doc-migration'], media: 'video', participantCount: 1, ...extra,
  });

  it('marks only the silent target missed, tells the caller, and keeps the call', async () => {
    const meta = new InMemoryDocumentCallMetaStore();
    const n = singleNode({ metaStore: meta });
    n.connect('c-host', 'u-host'); n.connect('c-alice', 'u-alice'); n.connect('c-bob', 'u-bob');
    await n.svc.handleCallEvent('c-host', 'invite', invite(['u-alice', 'u-bob']));
    expect(n.wire.filter((w) => w.message.action === 'invite').map((w) => w.clientId).sort()).toEqual(['c-alice', 'c-bob']);
    await n.svc.handleCallEvent('c-alice', 'accepted', { callId: 'd1', targetUserIds: ['u-host'] });

    const m1 = await meta.get('d1');
    expect(m1!.invites['u-alice'].state).toBe('accepted');
    expect(m1!.invites['u-bob'].state).toBe('ringing');

    n.wire.length = 0;
    await n.svc.runInviteSweep(Date.now() + TTL + 1);
    const m2 = await meta.get('d1');
    expect(m2).not.toBeNull();
    expect(m2!.invites['u-bob'].state).toBe('missed');
    expect(m2!.invites['u-alice'].state).toBe('accepted');
    const expired = n.wire.filter((w) => w.message.action === 'invite-expired');
    // The inviter (row → "Didn't answer") and Bob himself (his ring closes).
    expect(expired.map((w) => w.clientId).sort()).toEqual(['c-bob', 'c-host']);
    expect(expired[0].message.data).toEqual({ callId: 'd1', userId: 'u-bob', inviteAt: expect.any(Number) });
    // Everyone in the call learns Bob didn't answer.
    expect(n.wire.filter((w) => w.message.action === 'call-meta').map((w) => w.clientId).sort()).toEqual(['c-alice', 'c-host']);
    expect(n.svc.getStats().activeCalls).toBe(1);
    await n.svc.dispose();
  });

  it('never ends a document call over a ring, even when nobody answered', async () => {
    const meta = new InMemoryDocumentCallMetaStore();
    const n = singleNode({ metaStore: meta });
    n.connect('c-host', 'u-host'); n.connect('c-alice', 'u-alice');
    await n.svc.handleCallEvent('c-host', 'invite', invite(['u-alice']));
    await n.svc.runInviteSweep(Date.now() + TTL + 1);
    expect(n.svc.getStats().activeCalls).toBe(1);
    expect((await meta.get('d1'))!.invites['u-alice'].state).toBe('missed');
    await n.svc.dispose();
  });

  it('notifies offline targets instead of ringing, and ring:false rings nobody', async () => {
    const meta = new InMemoryDocumentCallMetaStore();
    const offline = jest.fn();
    const n = singleNode({ metaStore: meta, onOfflineInvite: offline });
    n.connect('c-host', 'u-host'); n.connect('c-alice', 'u-alice');
    await n.svc.handleCallEvent('c-host', 'invite', invite(['u-alice', 'u-frank'], { message: 'Review the sign-in flow' }));
    const m = await meta.get('d1');
    expect(m!.invites['u-alice'].state).toBe('ringing');
    expect(m!.invites['u-frank'].state).toBe('notified');
    expect(offline).toHaveBeenCalledWith('u-frank', expect.objectContaining({ callId: 'd1', title: 'Auth architecture review', message: 'Review the sign-in flow' }));
    expect(n.wire.filter((w) => w.message.action === 'invite').map((w) => w.clientId)).toEqual(['c-alice']);

    n.wire.length = 0; offline.mockClear();
    await n.svc.handleCallEvent('c-host', 'invite', { ...invite(['u-bob2']), callId: 'd2', ring: false });
    expect(n.wire.filter((w) => w.message.action === 'invite')).toHaveLength(0);
    expect(n.router.broadcasts).toHaveLength(0);
    expect((await meta.get('d2'))!.invites['u-bob2'].state).toBe('notified');
    expect(offline).toHaveBeenCalledTimes(1);
    await n.svc.dispose();
  });

  it('an invite with no targets starts the call without broadcasting to everyone', async () => {
    const meta = new InMemoryDocumentCallMetaStore();
    const n = singleNode({ metaStore: meta });
    n.connect('c-host', 'u-host'); n.connect('c-x', 'u-x');
    await n.svc.handleCallEvent('c-host', 'invite', invite([]));
    expect(n.router.broadcasts).toHaveLength(0);
    const m = await meta.get('d1');
    expect(m).toMatchObject({ hostUserId: 'u-host', title: 'Auth architecture review', documentIds: ['doc-auth', 'doc-migration'], presenting: null });
    // The caller gets the meta straight away.
    expect(n.wire.filter((w) => w.message.action === 'call-meta').map((w) => w.clientId)).toEqual(['c-host']);
    await n.svc.dispose();
  });

  it('replays a live ring after a refresh, with the document fields', async () => {
    const meta = new InMemoryDocumentCallMetaStore();
    const n = singleNode({ metaStore: meta });
    n.connect('c-host', 'u-host'); n.connect('c-alice', 'u-alice');
    await n.svc.handleCallEvent('c-host', 'invite', invite(['u-alice']));
    n.wire.length = 0;
    n.connect('c-alice-2', 'u-alice');
    await n.svc.replayActiveInvitesForUser('c-alice-2', 'u-alice');
    const replay = n.wire.find((w) => w.clientId === 'c-alice-2' && w.message.action === 'invite');
    expect(replay!.message.data).toMatchObject({ kind: 'document-review', title: 'Auth architecture review', documentIds: ['doc-auth', 'doc-migration'], replayed: true });
    await n.svc.dispose();
  });
});

describe('two replicas (shared Redis)', () => {
  it('rings a client on node B from node A, and invite-expired reaches the caller on A after the sweep on B', async () => {
    const c = makeCluster({ leader: 'B', rejoinGraceMs: 0 });
    c.connect('a-host', 'u-host', 'A');
    c.connect('b-alice', 'u-alice', 'B');
    c.connect('b-bob', 'u-bob', 'B');
    await c.A.svc.handleCallEvent('a-host', 'invite', {
      callId: 'x1', lobbyName: 'doc-auth', callerId: 'u-host', targetUserIds: ['u-alice', 'u-bob'],
      kind: 'document-review', documentId: 'doc-auth', title: 'Auth architecture review', documentIds: ['doc-auth'], media: 'video',
    });
    await flush();
    expect(c.frames('b-alice', 'invite')).toHaveLength(1);
    expect(c.frames('b-bob', 'invite')).toHaveLength(1);

    // Alice answers on B; Bob never does.
    await c.B.svc.handleCallEvent('b-alice', 'accepted', { callId: 'x1', targetUserIds: ['u-host'] });
    await flush();
    expect(c.frames('a-host', 'accepted')).toHaveLength(1);

    const later = Date.now() + TTL + 1;
    // Only B holds the sweep sentinel; A's timer tick skips.
    c.wire.length = 0;
    await c.B.svc.runInviteSweep(later);
    await flush();
    const expired = c.frames('a-host', 'invite-expired');
    expect(expired).toHaveLength(1);
    expect(expired[0].data).toEqual({ callId: 'x1', userId: 'u-bob', inviteAt: expect.any(Number) });
    expect(c.frames('b-bob', 'invite-expired')).toHaveLength(1);
    const meta = await new (require('../../src/call/CallStateStore').RedisDocumentCallMetaStore)(c.redis).get('x1');
    expect(meta.invites['u-bob'].state).toBe('missed');
    expect(meta.invites['u-alice'].state).toBe('accepted');
    // The call is intact on both nodes.
    expect(c.A.svc.getStats().activeCalls).toBe(1);
    await c.dispose();
  });
});
