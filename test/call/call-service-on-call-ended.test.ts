// A call used to leave no trace anywhere except the call itself. `onCallEnded`
// is the seam that lets a consumer record one — the gateway posts it into the
// conversation the call happened in, the way onDocumentCreated does for
// documents.
//
// What these pin is the difference between "a call happened" and "somebody
// tried to call you", and the fact that a broken recorder cannot break a
// hang-up.

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

function makeService(onCallEnded?: any, logger = new NoopLogger()) {
  return {
    svc: new CallService({
      messageRouter: makeRouter(),
      logger: logger as any,
      stateStore: new InMemoryCallStateStore(),
      rejoinGraceMs: 0,
      // Hooks live on `config`, alongside authorize / canCall /
      // persistCallBinding — not at the top level with the wiring.
      ...(onCallEnded ? { config: { onCallEnded } } : {}),
    }),
    logger,
  };
}

async function invite(svc: CallService, callId = 'call-1') {
  await svc.handleCallEvent('c-alice', 'invite', {
    callId, lobbyName: 'dm:u-alice:u-bob', callerId: 'u-alice',
    callerName: 'Alice Chen', targetUserIds: ['u-bob'],
  });
}
async function accept(svc: CallService, callId = 'call-1') {
  await svc.handleCallEvent('c-bob', 'accepted', {
    callId, lobbyName: 'dm:u-alice:u-bob', callerId: 'u-alice', targetUserIds: ['u-alice'],
  });
}
// `ended` removes the SENDING client; the call is over when the last one
// leaves. Both sides send it on a real hang-up (each client tears down its own
// session), so that is what these drive.
async function end(svc: CallService, callId = 'call-1', clients = ['c-alice', 'c-bob']) {
  for (const c of clients) {
    await svc.handleCallEvent(c, 'ended', {
      callId, lobbyName: 'dm:u-alice:u-bob', callerId: 'u-alice', targetUserIds: ['u-bob'],
    });
  }
}

describe('CallService — onCallEnded', () => {
  it('reports the call once it is over, with what a record needs', async () => {
    const onCallEnded = jest.fn();
    const { svc } = makeService(onCallEnded);
    await invite(svc);
    await accept(svc);
    await end(svc);

    expect(onCallEnded).toHaveBeenCalledTimes(1);
    const summary = onCallEnded.mock.calls[0]![0];
    expect(summary).toMatchObject({
      callId: 'call-1',
      lobbyName: 'dm:u-alice:u-bob',
      callerId: 'u-alice',
      callerName: 'Alice Chen',
    });
    expect(typeof summary.endedAt).toBe('number');
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  // The roster drains as people hang up, so by the time the last one leaves
  // it is empty. A record built from it named one person out of however many
  // were actually in the call.
  it('names everyone who was in the call, not whoever left last', async () => {
    const onCallEnded = jest.fn();
    const { svc } = makeService(onCallEnded);
    await invite(svc);
    await accept(svc);
    await end(svc);

    // Connections, not people — the consumer owns the router and resolves them.
    const ids: string[] = onCallEnded.mock.calls[0]![0].participantClientIds;
    expect([...ids].sort()).toEqual(['c-alice', 'c-bob']);
  });

  // The distinction the hook exists to make. "Alice called you" and "Alice
  // and Bob were on a call" are different sentences, and only one of them is
  // true when nobody picks up.
  it('says nothing about an invite nobody accepted', async () => {
    const onCallEnded = jest.fn();
    const { svc } = makeService(onCallEnded);
    await invite(svc);
    await end(svc);
    expect(onCallEnded).not.toHaveBeenCalled();
  });

  // Two participants leaving is one call ending.
  it('fires once, not once per participant leaving', async () => {
    const onCallEnded = jest.fn();
    const { svc } = makeService(onCallEnded);
    await invite(svc);
    await accept(svc);
    await end(svc);
    await end(svc);
    expect(onCallEnded).toHaveBeenCalledTimes(1);
  });

  // Until the last person leaves, the call is still happening.
  it('says nothing while somebody is still in the call', async () => {
    const onCallEnded = jest.fn();
    const { svc } = makeService(onCallEnded);
    await invite(svc);
    await accept(svc);
    await end(svc, 'call-1', ['c-alice']);
    expect(onCallEnded).not.toHaveBeenCalled();
  });

  // A hang-up must not depend on whatever records it.
  it('tears the call down even when the recorder throws', async () => {
    const onCallEnded = jest.fn(() => { throw new Error('recorder down'); });
    const { svc, logger } = makeService(onCallEnded);
    await invite(svc);
    await accept(svc);
    await expect(end(svc)).resolves.not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('onCallEnded'));
  });

  it('tears the call down when the recorder rejects', async () => {
    const onCallEnded = jest.fn(() => Promise.reject(new Error('async recorder down')));
    const { svc } = makeService(onCallEnded);
    await invite(svc);
    await accept(svc);
    await expect(end(svc)).resolves.not.toThrow();
  });

  it('is entirely optional', async () => {
    const { svc } = makeService();
    await invite(svc);
    await accept(svc);
    await expect(end(svc)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Room calls
// ---------------------------------------------------------------------------
//
// A room call has no invite and no accept — you join a PLACE — so none of the
// signaling-edge bookkeeping runs for it. Before this, `onCallEnded` could
// never fire for a room, and the record of a room call never reached the
// room's conversation even though the call plainly happened.

const ROOM_LOBBY = 'room:design';

function roomService(onCallEnded: any, roomBridge: any = {
  handleMemberJoined: jest.fn(), handleMemberLeft: jest.fn(),
}) {
  const svc = new CallService({
      messageRouter: makeRouter(),
      logger: new NoopLogger() as any,
      stateStore: new InMemoryCallStateStore(),
      rejoinGraceMs: 0,
    config: { onCallEnded },
  } as any);
  // The bridge is installed after construction, not passed in.
  svc.setRoomBridge(roomBridge);
  return { svc, roomBridge };
}

const joinRoom = (svc: CallService, clientId: string, userId: string, name: string) =>
  svc.handleCallEvent(clientId, 'participant-state', {
    callId: 'room-call-1', lobbyName: ROOM_LOBBY, callerId: userId,
    participantId: `${userId}-p`, displayName: name,
  } as any);

const leaveRoom = (svc: CallService, clientId: string, userId: string) =>
  svc.handleCallEvent(clientId, 'user-status', {
    callId: 'room-call-1', lobbyName: ROOM_LOBBY, callerId: userId, status: 'left',
  } as any);

describe('CallService — onCallEnded for rooms', () => {
  it('reports a room call once the last person leaves', async () => {
    const onCallEnded = jest.fn();
    const { svc } = roomService(onCallEnded);

    await joinRoom(svc, 'c-alice', 'u-alice', 'Alice Chen');
    await joinRoom(svc, 'c-bob', 'u-bob', 'Bob Martinez');
    expect(onCallEnded).not.toHaveBeenCalled();

    await leaveRoom(svc, 'c-alice', 'u-alice');
    // Bob is still in the room — the call is still happening.
    expect(onCallEnded).not.toHaveBeenCalled();

    await leaveRoom(svc, 'c-bob', 'u-bob');
    expect(onCallEnded).toHaveBeenCalledTimes(1);

    const summary = onCallEnded.mock.calls[0]![0];
    expect(summary).toMatchObject({
      lobbyName: ROOM_LOBBY,
      callId: 'room-call-1',
      // Whoever opened the room started its call.
      callerId: 'u-alice',
      callerName: 'Alice Chen',
    });
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  // The roster drains as people leave, so a record built from who is still
  // present would name nobody at all.
  it('names everyone who was ever in the room', async () => {
    const onCallEnded = jest.fn();
    const { svc } = roomService(onCallEnded);
    await joinRoom(svc, 'c-alice', 'u-alice', 'Alice Chen');
    await joinRoom(svc, 'c-bob', 'u-bob', 'Bob Martinez');
    await leaveRoom(svc, 'c-alice', 'u-alice');
    await leaveRoom(svc, 'c-bob', 'u-bob');

    const ids: string[] = onCallEnded.mock.calls[0]![0].participantClientIds;
    expect([...ids].sort()).toEqual(['c-alice', 'c-bob']);
  });

  it('does not announce the same room call twice', async () => {
    const onCallEnded = jest.fn();
    const { svc } = roomService(onCallEnded);
    await joinRoom(svc, 'c-alice', 'u-alice', 'Alice Chen');
    await leaveRoom(svc, 'c-alice', 'u-alice');
    await leaveRoom(svc, 'c-alice', 'u-alice');
    expect(onCallEnded).toHaveBeenCalledTimes(1);
  });

  // Re-entering an empty room is a NEW call, not a continuation.
  it('starts a fresh call when somebody comes back', async () => {
    const onCallEnded = jest.fn();
    const { svc } = roomService(onCallEnded);
    await joinRoom(svc, 'c-alice', 'u-alice', 'Alice Chen');
    await leaveRoom(svc, 'c-alice', 'u-alice');
    await joinRoom(svc, 'c-bob', 'u-bob', 'Bob Martinez');
    await leaveRoom(svc, 'c-bob', 'u-bob');

    expect(onCallEnded).toHaveBeenCalledTimes(2);
    expect(onCallEnded.mock.calls[1]![0].callerId).toBe('u-bob');
  });

  it('still mirrors membership to the room bridge', async () => {
    const onCallEnded = jest.fn();
    const { svc, roomBridge } = roomService(onCallEnded);
    await joinRoom(svc, 'c-alice', 'u-alice', 'Alice Chen');
    await leaveRoom(svc, 'c-alice', 'u-alice');
    expect(roomBridge.handleMemberJoined).toHaveBeenCalled();
    expect(roomBridge.handleMemberLeft).toHaveBeenCalled();
  });
});
