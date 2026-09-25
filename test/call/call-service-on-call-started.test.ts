// realtime-modules/test/call/call-service-on-call-started.test.ts
//
// The other end of the record. `onCallEnded` turns a call into history;
// `onCallStarted` is what lets a conversation show a LIVE card while there is
// something to join, and `onCallMissed` is the record of an invite that never
// became a call. The gateway posts one card at start and patches it at end,
// so each must fire exactly once per call and never for the wrong kind.

import { CallService } from '../../src/call/CallService';
import { InMemoryCallStateStore } from '../../src/call/CallStateStore';
import type { CallMessageRouter } from '../../src/call/types';

class NoopLogger {
  debug() {/* noop */} info() {/* noop */} error() {/* noop */}
  warn = jest.fn();
}
const users = { 'c-alice': 'u-alice', 'c-bob': 'u-bob' };
function makeRouter() {
  const sent: Array<{ clientId: string; message: any }> = [];
  return {
    sent,
    sendToClient(clientId: string, message: any) { sent.push({ clientId, message }); return true; },
    broadcastToAll() { return undefined; },
    getClientsByUserId(userIds: string[]) {
      return Object.entries(users)
        .filter(([, uid]) => userIds.includes(uid))
        .map(([cid, uid]) => ({ clientId: cid, userId: uid }));
    },
    getUserIdForClient(clientId: string) { return (users as any)[clientId] ?? null; },
  } as unknown as CallMessageRouter & { sent: any[] };
}
function makeService(config: Record<string, unknown>) {
  return new CallService({
    messageRouter: makeRouter(),
    logger: new NoopLogger() as any,
    stateStore: new InMemoryCallStateStore(),
    rejoinGraceMs: 0,
    config,
  });
}
const lobby = 'dm:u-alice:u-bob';
async function invite(svc: CallService, callId = 'call-1') {
  await svc.handleCallEvent('c-alice', 'invite', {
    callId, lobbyName: lobby, callerId: 'u-alice', callerName: 'Alice Chen', targetUserIds: ['u-bob'],
  });
}
async function accept(svc: CallService, callId = 'call-1') {
  await svc.handleCallEvent('c-bob', 'accepted', { callId, lobbyName: lobby, callerId: 'u-alice', targetUserIds: ['u-alice'] });
}
async function verb(svc: CallService, client: string, action: any, callId = 'call-1') {
  await svc.handleCallEvent(client, action, { callId, lobbyName: lobby, callerId: 'u-alice', targetUserIds: ['u-bob'] });
}
const flush = () => new Promise((r) => setImmediate(r));

describe('CallService — onCallStarted', () => {
  it('fires once, at the first accept, with who is in it', async () => {
    const onCallStarted = jest.fn();
    const svc = makeService({ onCallStarted });
    await invite(svc);
    expect(onCallStarted).not.toHaveBeenCalled();
    await accept(svc);
    await accept(svc);
    expect(onCallStarted).toHaveBeenCalledTimes(1);
    const summary = onCallStarted.mock.calls[0]![0];
    expect(summary).toMatchObject({ callId: 'call-1', lobbyName: lobby, callerId: 'u-alice', callerName: 'Alice Chen' });
    expect(typeof summary.startedAt).toBe('number');
    expect([...summary.participantClientIds].sort()).toEqual(['c-alice', 'c-bob']);
    svc.dispose();
  });

  // The card's clock: time in the call, not time spent ringing.
  it('the ended record measures from the accept, not the invite', async () => {
    const onCallStarted = jest.fn();
    const onCallEnded = jest.fn();
    const svc = makeService({ onCallStarted, onCallEnded });
    await invite(svc);
    await accept(svc);
    await verb(svc, 'c-alice', 'ended');
    await verb(svc, 'c-bob', 'ended');
    expect(onCallEnded).toHaveBeenCalledTimes(1);
    expect(onCallEnded.mock.calls[0]![0].startedAt).toBe(onCallStarted.mock.calls[0]![0].startedAt);
    svc.dispose();
  });
});

describe('CallService — onCallMissed', () => {
  it('a caller who hangs up before anyone answers left a missed call', async () => {
    const onCallMissed = jest.fn();
    const onCallEnded = jest.fn();
    const svc = makeService({ onCallMissed, onCallEnded });
    await invite(svc);
    await verb(svc, 'c-alice', 'cancelled');
    await flush();
    expect(onCallEnded).not.toHaveBeenCalled();
    expect(onCallMissed).toHaveBeenCalledTimes(1);
    expect(onCallMissed.mock.calls[0]![0]).toMatchObject({ callId: 'call-1', lobbyName: lobby, callerId: 'u-alice', callerName: 'Alice Chen', reason: 'cancelled' });
    svc.dispose();
  });

  it('remembers a decline when the caller then hangs up', async () => {
    const onCallMissed = jest.fn();
    const svc = makeService({ onCallMissed });
    await invite(svc);
    await verb(svc, 'c-bob', 'declined');
    await verb(svc, 'c-alice', 'ended');
    await flush();
    expect(onCallMissed).toHaveBeenCalledTimes(1);
    expect(onCallMissed.mock.calls[0]![0].reason).toBe('declined');
    svc.dispose();
  });

  it('never fires for a call that was answered', async () => {
    const onCallMissed = jest.fn();
    const svc = makeService({ onCallMissed });
    await invite(svc);
    await accept(svc);
    await verb(svc, 'c-alice', 'ended');
    await verb(svc, 'c-bob', 'ended');
    await flush();
    expect(onCallMissed).not.toHaveBeenCalled();
    svc.dispose();
  });
});
