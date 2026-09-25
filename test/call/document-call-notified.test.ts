// Offline invitees of a document call are `notified` (onOfflineInvite runs),
// including one whose only "connection" is a stale index entry for a tab that
// died with its replica — that must not read as online and ring nobody.

import { RedisDocumentCallMetaStore } from '../../src/call/CallStateStore';
import { makeCluster, flush } from './helpers/cluster';

it('rings live invitees on the other replica, notifies offline and stale-only ones', async () => {
  const offline = jest.fn();
  const dead = new Set<string>(['b-carol-stale']);
  const c = makeCluster({ rejoinGraceMs: 0, onOfflineInvite: offline, isClientAlive: (cid: string) => !dead.has(cid) });
  c.connect('a-host', 'u-host', 'A');
  c.connect('b-alice', 'u-alice', 'B');
  c.connect('b-carol-stale', 'u-carol', 'B'); // still in the user index, its replica is gone
  await c.A.svc.handleCallEvent('a-host', 'invite', {
    callId: 'd1', lobbyName: 'doc-auth', callerId: 'u-host', callerName: 'Connor', targetUserIds: ['u-alice', 'u-carol', 'u-dan'],
    kind: 'document-review', documentId: 'doc-auth', title: 'Auth architecture review', documentIds: ['doc-auth'], media: 'video',
  });
  await flush();
  const meta = await new RedisDocumentCallMetaStore(c.redis as any).get('d1');
  expect(meta!.invites['u-alice'].state).toBe('ringing');
  expect(meta!.invites['u-carol'].state).toBe('notified');
  expect(meta!.invites['u-dan'].state).toBe('notified');
  expect(offline.mock.calls.map((call) => call[0]).sort()).toEqual(['u-carol', 'u-dan']);
  expect(offline).toHaveBeenCalledWith('u-dan', expect.objectContaining({ callId: 'd1', title: 'Auth architecture review', callerId: 'u-host' }));
  expect(c.frames('b-alice', 'invite')).toHaveLength(1);
  expect(c.frames('b-carol-stale', 'invite')).toHaveLength(0);
  // The host's call-meta carries the notified rows for the People list.
  const hostMeta = c.frames('a-host', 'call-meta').pop().data;
  expect(hostMeta.invites['u-carol'].state).toBe('notified');
  await c.dispose();
});
