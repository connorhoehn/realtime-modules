// The sidebar room row that rendered "?" instead of a person's initials.
//
// Two signals write the SAME membership record. The explicit `join` carries
// `displayName` + `participantId`; the call→room bridge in CallService
// (:1272) carries neither and passes `''` for both. `handleMemberJoined`
// replaced the record wholesale, so the second signal blanked the first —
// and `displayName ?? userId` never fires on an empty STRING, so the empty
// name reached ui-components' Avatar, whose only answer to a nameless person
// is "?".
//
// Nothing announced the change either: the member-joined fan-out is gated on
// `!already`, while `stateStore.addMember` is not — so the blank won in the
// store silently.

import { RoomService } from '../../src/room/RoomService';

class NoopLogger {
  debug() {/* noop */}
  info() {/* noop */}
  warn() {/* noop */}
  error() {/* noop */}
}

function makeRouter() {
  return { sendToClient: () => true } as any;
}

/** Stand-in for the durable rooms index the viewer's sidebar actually reads. */
function makeStateStore() {
  const members = new Map<string, { userId: string; displayName: string; participantId: string }>();
  return {
    members,
    async addMember(_slug: string, clientId: string, userId: string, displayName: string, participantId: string) {
      members.set(clientId, { userId, displayName, participantId });
    },
    async removeMember() { /* noop */ },
    async getMembers() { return []; },
    async getCount() { return 0; },
  } as any;
}

describe('RoomService.handleMemberJoined — identity survives the call bridge', () => {
  test('a later identity-less signal does not blank the name the join supplied', async () => {
    const stateStore = makeStateStore();
    const svc = new RoomService({
      messageRouter: makeRouter(),
      logger: new NoopLogger() as any,
      stateStore,
    } as any);

    // 1. The explicit room join, with a real identity.
    await svc.handleMemberJoined('rail-probe', 'dev-hank', 'c-hank', 'p-hank', 'Hank Anderson');
    // 2. The CallService user-status bridge, moments later, with nothing.
    await svc.handleMemberJoined('rail-probe', 'dev-hank', 'c-hank', '', '');

    const stored = stateStore.members.get('c-hank');
    expect(stored).toEqual({
      userId: 'dev-hank',
      displayName: 'Hank Anderson',
      participantId: 'p-hank',
    });
    await svc.dispose();
  });

  test('a later signal that DOES carry a name is allowed to fill one in', async () => {
    const stateStore = makeStateStore();
    const svc = new RoomService({
      messageRouter: makeRouter(),
      logger: new NoopLogger() as any,
      stateStore,
    } as any);

    // Bridge first this time — no identity to record yet.
    await svc.handleMemberJoined('rail-probe', 'dev-hank', 'c-hank', '', '');
    // The real join lands second and must win: this is a merge, not a lock.
    await svc.handleMemberJoined('rail-probe', 'dev-hank', 'c-hank', 'p-hank', 'Hank Anderson');

    expect(stateStore.members.get('c-hank')).toEqual({
      userId: 'dev-hank',
      displayName: 'Hank Anderson',
      participantId: 'p-hank',
    });
    await svc.dispose();
  });

  test('two members in one room keep their own identities', async () => {
    const stateStore = makeStateStore();
    const svc = new RoomService({
      messageRouter: makeRouter(),
      logger: new NoopLogger() as any,
      stateStore,
    } as any);

    await svc.handleMemberJoined('rail-probe', 'dev-hank', 'c-hank', 'p-hank', 'Hank Anderson');
    await svc.handleMemberJoined('rail-probe', 'dev-alice', 'c-alice', 'p-alice', 'Alice Chen');
    await svc.handleMemberJoined('rail-probe', 'dev-hank', 'c-hank', '', '');
    await svc.handleMemberJoined('rail-probe', 'dev-alice', 'c-alice', '', '');

    expect(stateStore.members.get('c-hank')?.displayName).toBe('Hank Anderson');
    expect(stateStore.members.get('c-alice')?.displayName).toBe('Alice Chen');
    await svc.dispose();
  });
});
