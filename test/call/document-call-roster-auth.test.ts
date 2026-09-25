// Lane D's frame capture: after Frank accepted (and had a dock), a
// non-participant's `status` listed only the host. Cause: the gateway's
// anti-spoofing `authorize` refuses a frame whose callerId is not the
// sender's own user, and useDocumentCall sent `accepted` (and a non-host's
// `ended`, and a decline) with the HOST as callerId — so the accept never
// registered. These tests run with that same authorize, using the frame
// shapes the hooks now send.

import { makeCluster, flush, type Directory } from './helpers/cluster';

function gatewayAuthorize(dir: Directory) {
  return (clientId: string, _action: string, data: { callerId?: unknown }) => {
    const declared = typeof data?.callerId === 'string' ? data.callerId : null;
    if (!declared) return true;
    return dir.get(clientId)?.userId === declared;
  };
}

async function setup() {
  let dirRef: Directory | null = null;
  const c = makeCluster({ rejoinGraceMs: 0, config: { authorize: (cid, a, d) => gatewayAuthorize(dirRef!)(cid, a, d) } });
  dirRef = c.dir;
  c.connect('a-connor', 'u-connor', 'A');
  c.connect('b-frank', 'u-frank', 'B');
  c.connect('b-alice', 'u-alice', 'B');
  // useDocumentCall.start → invite (callerId is the sender: allowed)
  await c.A.svc.handleCallEvent('a-connor', 'invite', {
    callId: 'sess-1', lobbyName: 'doc-auth', targetUserIds: ['u-alice', 'u-frank'], callerId: 'u-connor', callerName: 'Connor Hoehn',
    kind: 'document-review', documentId: 'doc-auth', title: 'Auth architecture review', documentIds: ['doc-auth', 'doc-migration'],
    media: 'video', participantCount: 1, participants: [{ userId: 'u-connor', displayName: 'Connor Hoehn' }],
  });
  await c.A.svc.handleCallEvent('a-connor', 'participant-state', {
    callId: 'sess-1', lobbyName: 'doc-auth', callerId: 'u-connor', userId: 'u-connor', displayName: 'Connor Hoehn', audioOn: true, cameraOn: true, screenSharing: false, status: 'in-call',
  });
  // useDocumentCall.join on Frank's replica, from a different page (lobbyName = the page he is on).
  await c.B.svc.handleCallEvent('b-frank', 'accepted', {
    callId: 'sess-1', lobbyName: 'doc-other', targetUserIds: ['u-connor'], userId: 'u-frank', displayName: 'Frank Davis',
  });
  await c.B.svc.handleCallEvent('b-frank', 'participant-state', {
    callId: 'sess-1', lobbyName: 'doc-auth', callerId: 'u-frank', userId: 'u-frank', displayName: 'Frank Davis', audioOn: true, cameraOn: true, screenSharing: false, status: 'in-call',
  });
  await flush();
  return c;
}

async function status(c: ReturnType<typeof makeCluster>, node: 'A' | 'B', asker: string) {
  c.wire.length = 0;
  await c[node].svc.handleCallEvent(asker, 'status', { lobbyName: 'doc-auth' });
  await flush();
  return c.frames(asker, 'active-call')[0].data;
}

describe('document-call roster under the gateway authorize (two replicas)', () => {
  it('the host starts on A, Frank accepts on B: a non-participant sees [connor, frank] from either node', async () => {
    const c = await setup();
    expect(c.wire.filter((w) => w.message.type === 'error')).toHaveLength(0);
    expect(c.frames('a-connor', 'accepted')).toHaveLength(1);
    // Alice (invited, still ringing) asks from B; Eve asks from A.
    const fromB = await status(c, 'B', 'b-alice');
    expect(fromB).toMatchObject({ active: true, callId: 'sess-1', participantCount: 2 });
    expect([...fromB.participantUserIds].sort()).toEqual(['u-connor', 'u-frank']);
    c.connect('a-eve', 'u-eve', 'A');
    const fromA = await status(c, 'A', 'a-eve');
    expect([...fromA.participantUserIds].sort()).toEqual(['u-connor', 'u-frank']);
    await c.dispose();
  });

  it("Frank's leave and Alice's decline (hook shapes) get through", async () => {
    const c = await setup();
    await c.B.svc.handleCallEvent('b-alice', 'declined', { callId: 'sess-1', lobbyName: 'doc-auth', targetUserIds: ['u-connor'], userId: 'u-alice', reason: 'not-now' });
    await c.B.svc.handleCallEvent('b-frank', 'ended', { callId: 'sess-1', lobbyName: 'doc-auth', userId: 'u-frank' });
    await flush();
    expect(c.wire.filter((w) => w.message.type === 'error')).toHaveLength(0);
    expect(c.frames('a-connor', 'declined')[0].data).toMatchObject({ userId: 'u-alice', reason: 'not-now' });
    expect(c.frames('a-connor', 'user-status').pop().data).toMatchObject({ userId: 'u-frank', status: 'left' });
    c.connect('a-eve', 'u-eve', 'A');
    expect((await status(c, 'A', 'a-eve')).participantUserIds).toEqual(['u-connor']);
    await c.dispose();
  });
});
