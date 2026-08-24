// UX audit 2026-08-24 — room lifecycle announce relay.
//
// A newly-created room used to be invisible to other users' sidebars
// until a full page reload: platform-api's REST create had no push
// channel to the gateway. The `announce` verb closes the loop — the
// creating client relays {event, slug, room} over WS and RoomService
// fans a `created`/`updated`/`archived` frame to every rooms:index
// subscriber (minus the announcer), plus cross-node replication.

import { RoomService } from '../../src/room/RoomService';
import { CROSS_NODE_ROOM_TOPIC, type CrossNodeRoomEvent } from '../../src/room/types';

class NoopLogger {
  debug() {/* noop */}
  info() {/* noop */}
  warn() {/* noop */}
  error() {/* noop */}
}

interface Sent { clientId: string; message: any }

function makeRouter() {
  const sent: Sent[] = [];
  return {
    sent,
    sendToClient(clientId: string, message: any) {
      sent.push({ clientId, message });
      return true;
    },
  } as any;
}

const ROOM = {
  orgId: 'default-org', roomId: 'r-1', slug: 'demo-room', name: 'Demo Room',
  createdBy: 'u-alice', createdAt: '2026-08-24T00:00:00.000Z',
  visibility: 'org', settings: { audioOnly: false, recordingEnabled: false, softCap: 8 },
  state: 'active', lastActiveAt: '2026-08-24T00:00:00.000Z',
};

describe('RoomService — lifecycle announce', () => {
  test('created fans to index subscribers except the announcer, room passthrough intact', async () => {
    const router = makeRouter();
    const svc = new RoomService({ messageRouter: router, logger: new NoopLogger() as any });

    await svc.handleAction('c-alice', 'subscribe-index', {});
    await svc.handleAction('c-bob', 'subscribe-index', {});
    await svc.handleAction('c-carol', 'subscribe-index', {});
    router.sent.length = 0; // drop initial snapshots

    await svc.handleAction('c-alice', 'announce', { event: 'created', slug: 'demo-room', room: ROOM });

    const recipients = router.sent.map((s: Sent) => s.clientId).sort();
    expect(recipients).toEqual(['c-bob', 'c-carol']);
    for (const s of router.sent) {
      expect(s.message.type).toBe('room');
      expect(s.message.action).toBe('created');
      expect(s.message.data.slug).toBe('demo-room');
      expect(s.message.data.room).toMatchObject({ slug: 'demo-room', name: 'Demo Room' });
    }
    await svc.dispose();
  });

  test('invalid event / missing slug error to sender only', async () => {
    const router = makeRouter();
    const svc = new RoomService({ messageRouter: router, logger: new NoopLogger() as any });
    await svc.handleAction('c-bob', 'subscribe-index', {});
    router.sent.length = 0;

    await svc.handleAction('c-alice', 'announce', { event: 'exploded', slug: 'demo-room' });
    await svc.handleAction('c-alice', 'announce', { event: 'created' });

    expect(router.sent).toHaveLength(2);
    for (const s of router.sent) {
      expect(s.clientId).toBe('c-alice');
      expect(s.message.type).toBe('error');
    }
    await svc.dispose();
  });

  test('replicates cross-node once; inbound peer lifecycle mirrors locally without re-publish', async () => {
    const published: string[] = [];
    let inboundHandler: ((payload: string) => void) | null = null;
    const pubsub = {
      publish: (_topic: string, payload: string) => { published.push(payload); },
      subscribe: (_topic: string, handler: (payload: string) => void) => {
        inboundHandler = handler;
        return () => { inboundHandler = null; };
      },
    };

    const router = makeRouter();
    const svc = new RoomService({
      messageRouter: router,
      logger: new NoopLogger() as any,
      crossNodePubSub: pubsub as any,
      nodeId: 'node-a',
    });
    await svc.handleAction('c-bob', 'subscribe-index', {});
    router.sent.length = 0;

    // Outbound: announce publishes exactly one cross-node event.
    await svc.handleAction('c-alice', 'announce', { event: 'archived', slug: 'demo-room' });
    expect(published).toHaveLength(1);
    const evt = JSON.parse(published[0]!) as CrossNodeRoomEvent;
    expect(evt).toMatchObject({ verb: 'lifecycle', event: 'archived', slug: 'demo-room', sourceNodeId: 'node-a' });

    // Inbound from a PEER node: mirrors to local subscribers, does NOT
    // re-publish (no ping-pong).
    router.sent.length = 0;
    published.length = 0;
    inboundHandler!(JSON.stringify({
      verb: 'lifecycle', event: 'created', slug: 'peer-room', room: { ...ROOM, slug: 'peer-room' },
      clientId: '', userId: '', sourceNodeId: 'node-b',
    } satisfies CrossNodeRoomEvent & Record<string, unknown>));
    await new Promise((r) => setTimeout(r, 10));

    expect(router.sent.map((s: Sent) => s.clientId)).toEqual(['c-bob']);
    expect(router.sent[0]!.message.action).toBe('created');
    expect(router.sent[0]!.message.data.room.slug).toBe('peer-room');
    expect(published).toHaveLength(0);

    // Loop suppression: our own publish echoed back is ignored.
    router.sent.length = 0;
    inboundHandler!(JSON.stringify({
      verb: 'lifecycle', event: 'created', slug: 'self-room',
      clientId: '', userId: '', sourceNodeId: 'node-a',
    }));
    await new Promise((r) => setTimeout(r, 10));
    expect(router.sent).toHaveLength(0);
    await svc.dispose();
  });
});
