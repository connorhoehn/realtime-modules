// 0.146.0: an invite's and a join's callerId / callerName come from the
// sender's auth context, never the frame. Before, the invitee's ring showed
// whatever name the caller typed into the frame.

import { CallService } from '../../src/call/CallService';

class Quiet { debug() {} info() {} warn() {} error() {} }

const ctx: Record<string, { userId: string; displayName?: string }> = {
  'c-alice': { userId: 'u-alice', displayName: 'Alice Real' },
  'c-bob': { userId: 'u-bob', displayName: 'Bob' },
  'c-long': { userId: 'u-long', displayName: 'L'.repeat(200) },
  'c-noname': { userId: 'u-noname' },
};

function makeRouter() {
  const sent: Array<{ clientId: string; message: any }> = [];
  return {
    sent,
    sendToClient(clientId: string, message: any) { sent.push({ clientId, message }); return true; },
    broadcastToAll() { return undefined; },
    getClientData(clientId: string) { return ctx[clientId] ? { userContext: ctx[clientId] } : null; },
    getUserIdForClient(clientId: string) { return ctx[clientId]?.userId; },
    getClientsByUserId(userIds: string[], exclude?: string) {
      return Object.entries(ctx).filter(([cid, c]) => cid !== exclude && userIds.includes(c.userId))
        .map(([clientId, c]) => ({ clientId, userId: c.userId }));
    },
  };
}

const ringFor = (router: ReturnType<typeof makeRouter>, clientId: string) =>
  router.sent.find((s) => s.clientId === clientId && s.message.type === 'call' && s.message.action === 'invite')?.message.data;

describe('CallService — the caller is the socket, not the frame', () => {
  it('a spoofed callerName / callerId in the invite does not reach the invitee', async () => {
    const router = makeRouter();
    const svc = new CallService({ messageRouter: router as any, logger: new Quiet() as any });
    await svc.handleCallEvent('c-alice', 'invite', {
      callId: 'k1', lobbyName: 'acme:dm:u-alice:u-bob', callerId: 'u-ceo',
      callerName: 'The CEO (urgent)', targetUserIds: ['u-bob'],
    });
    const ring = ringFor(router, 'c-bob');
    expect(ring).toMatchObject({ callerId: 'u-alice', callerName: 'Alice Real' });
    expect(JSON.stringify(router.sent)).not.toContain('The CEO');
    await svc.dispose();
  });

  it('clamps the context name to 80 characters', async () => {
    const router = makeRouter();
    const svc = new CallService({ messageRouter: router as any, logger: new Quiet() as any });
    await svc.handleCallEvent('c-long', 'invite', { callId: 'k2', lobbyName: 'acme:huddle', callerId: 'u-long', targetUserIds: ['u-bob'] });
    expect(ringFor(router, 'c-bob').callerName).toHaveLength(80);
    await svc.dispose();
  });

  it('drops the frame name when the context has none', async () => {
    const router = makeRouter();
    const svc = new CallService({ messageRouter: router as any, logger: new Quiet() as any });
    await svc.handleCallEvent('c-noname', 'invite', { callId: 'k3', lobbyName: 'acme:huddle', callerId: 'u-noname', callerName: 'Someone Else', targetUserIds: ['u-bob'] });
    const ring = ringFor(router, 'c-bob');
    expect(ring.callerId).toBe('u-noname');
    expect(ring.callerName).toBeUndefined();
    await svc.dispose();
  });

  it('a join announces the context name to those already seated', async () => {
    const router = makeRouter();
    const svc = new CallService({ messageRouter: router as any, logger: new Quiet() as any });
    await svc.handleCallEvent('c-bob', 'join', { callId: 'h1', lobbyName: 'acme:team:t1', callerId: 'u-bob', callerName: 'Bob' });
    await svc.handleCallEvent('c-alice', 'join', { callId: 'h1', lobbyName: 'acme:team:t1', callerId: 'u-ceo', callerName: 'The CEO' });
    const status = router.sent.find((s) => s.clientId === 'c-bob' && s.message.action === 'user-status')?.message.data;
    expect(status).toMatchObject({ userId: 'u-alice', callerId: 'u-alice', displayName: 'Alice Real' });
    expect(JSON.stringify(router.sent)).not.toContain('The CEO');
    await svc.dispose();
  });
});
