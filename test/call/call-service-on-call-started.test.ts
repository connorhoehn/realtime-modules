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

describe('CallService — the end is announced from wherever the call is seen to end', () => {
  // Both tabs close together. The roster in the store must lose both, or
  // the grace timer re-reads a roster of two, decides they "rejoined", and
  // the call lives on with nobody in it.
  it('two people dropping together end the call, once, at the moment the last one dropped', async () => {
    jest.useFakeTimers();
    try {
      const onCallEnded = jest.fn();
      const store = new InMemoryCallStateStore();
      const svc = new CallService({
        messageRouter: makeRouter(), logger: new NoopLogger() as any, stateStore: store, rejoinGraceMs: 30_000, config: { onCallEnded },
      });
      await invite(svc);
      await accept(svc);
      const t0 = Date.now();
      jest.setSystemTime(t0 + 5_000);
      await svc.handleDisconnect('c-alice');
      // Alone now: the grace is armed for a possible rejoin.
      expect(onCallEnded).not.toHaveBeenCalled();
      await svc.handleDisconnect('c-bob');
      // Nobody left anywhere (the store's roster lost both): over now.
      expect(onCallEnded).toHaveBeenCalledTimes(1);
      expect(onCallEnded.mock.calls[0]![0].endedAt).toBe(t0 + 5_000);
      jest.setSystemTime(t0 + 35_000);
      await jest.advanceTimersByTimeAsync(31_000);
      // The armed grace timer finds nothing to announce a second time.
      expect(onCallEnded).toHaveBeenCalledTimes(1);
      svc.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  // Two nodes: the accept landed on the other node, so this one never had
  // the call in its local accepted set. The cluster marker says it was
  // accepted, and this node — which saw the last person leave — announces
  // the end rather than a missed call.
  it('a call accepted on a peer node is announced as ended, not missed', async () => {
    const onCallEnded = jest.fn();
    const onCallMissed = jest.fn();
    const store = new InMemoryCallStateStore();
    await store.markAccepted('call-1', 600);
    const svc = new CallService({
      messageRouter: makeRouter(), logger: new NoopLogger() as any, stateStore: store, rejoinGraceMs: 0, config: { onCallEnded, onCallMissed },
    });
    await invite(svc);
    await verb(svc, 'c-alice', 'ended');
    await flush();
    expect(onCallMissed).not.toHaveBeenCalled();
    expect(onCallEnded).toHaveBeenCalledTimes(1);
    expect(onCallEnded.mock.calls[0]![0].callId).toBe('call-1');
    svc.dispose();
  });

  it('a peer that already announced the end leaves nothing for this node to say', async () => {
    const onCallEnded = jest.fn();
    const onCallMissed = jest.fn();
    const store = new InMemoryCallStateStore();
    await store.markAccepted('call-1', 600);
    await store.takeAccepted('call-1');
    // The store still lists the other party, so it is not a missed call either.
    await store.registerParticipant('call-1', 'c-bob', 'u-alice', lobby, ['u-bob']);
    const svc = new CallService({
      messageRouter: makeRouter(), logger: new NoopLogger() as any, stateStore: store, rejoinGraceMs: 0, config: { onCallEnded, onCallMissed },
    });
    await invite(svc);
    await verb(svc, 'c-alice', 'ended');
    await flush();
    expect(onCallEnded).not.toHaveBeenCalled();
    expect(onCallMissed).not.toHaveBeenCalled();
    svc.dispose();
  });
});

describe('CallService — a lone drop ends after the grace, dated when they dropped', () => {
  it('records the drop time, not the grace expiry', async () => {
    jest.useFakeTimers();
    try {
      const onCallEnded = jest.fn();
      const svc = new CallService({
        messageRouter: makeRouter(), logger: new NoopLogger() as any, stateStore: new InMemoryCallStateStore(), rejoinGraceMs: 30_000, config: { onCallEnded },
      });
      await invite(svc);
      await accept(svc);
      const t0 = Date.now();
      jest.setSystemTime(t0 + 5_000);
      await svc.handleDisconnect('c-alice');
      expect(onCallEnded).not.toHaveBeenCalled();
      jest.setSystemTime(t0 + 35_000);
      await jest.advanceTimersByTimeAsync(31_000);
      expect(onCallEnded).toHaveBeenCalledTimes(1);
      expect(onCallEnded.mock.calls[0]![0].endedAt).toBe(t0 + 5_000);
      svc.dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});
