/**
 * @jest-environment jsdom
 */
// Hooks wired to the REAL CallService on two replicas (shared Redis double):
// the frames the hooks send go through handleAction (with the gateway's
// anti-spoofing authorize), and the frames the service sends are delivered
// back to the hooks. Covers lane D/E's "Not now → Declined" and "Didn't
// answer" on the caller's row, the invitee's ring closing on the server's
// clock, and a document call's first participant-state never leaking to
// everyone.

import { describe, it, expect, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { useDocumentCall } from '../../../src/client/video/useDocumentCall';
import { useIncomingDocumentCalls } from '../../../src/client/video/useIncomingDocumentCalls';
import { makeCluster } from '../../call/helpers/cluster';
import { makeFakePlatformApi } from './fakeGateway';
import type { GatewayMessage } from '../../../src/client/types';

const tick = () => new Promise((r) => setTimeout(r, 0));

function harness() {
  const ref: { dir: any } = { dir: null };
  const c = makeCluster({
    rejoinGraceMs: 0,
    config: {
      authorize: (cid: string, _a: string, data: { callerId?: unknown }) => {
        const declared = typeof data?.callerId === 'string' ? data.callerId : null;
        return !declared || ref.dir.get(cid)?.userId === declared;
      },
    },
  });
  ref.dir = c.dir;
  const handlers = new Map<string, Set<(m: GatewayMessage) => void>>();
  const sentBy = new Map<string, Record<string, unknown>[]>();
  let delivered = 0;
  const pump = async () => {
    for (let round = 0; round < 10; round++) {
      await tick();
      while (delivered < c.wire.length) {
        const { clientId, message } = c.wire[delivered++];
        for (const h of handlers.get(clientId) ?? []) h(message as GatewayMessage);
      }
    }
  };
  const gateway = (clientId: string, userId: string, node: 'A' | 'B') => {
    c.connect(clientId, userId, node);
    return {
      connectionState: 'connected',
      send: (msg: Record<string, unknown>) => {
        (sentBy.get(clientId) ?? sentBy.set(clientId, []).get(clientId)!).push(msg);
        if (msg.service !== 'call') return;
        void c[node].svc.handleAction(clientId, String(msg.action), msg as any);
      },
      onMessage: (h: (m: GatewayMessage) => void) => {
        let set = handlers.get(clientId);
        if (!set) { set = new Set(); handlers.set(clientId, set); }
        set.add(h);
        return () => { set!.delete(h); };
      },
    };
  };
  return { c, pump, gateway, sentBy };
}

describe('live sequence: hooks ↔ CallService on two replicas', () => {
  it('Not now → Declined and no answer → Didn\'t answer, on every caller tab, and the ring closes on the server\'s clock', async () => {
    const { c, pump, gateway } = harness();
    const pa = makeFakePlatformApi();
    const connorA = gateway('a-connor', 'dev-connor', 'A');
    const connorB = gateway('b-connor-2', 'dev-connor', 'B'); // a second tab on the other replica
    const aliceGw = gateway('b-alice', 'dev-alice', 'B');
    const bobGw = gateway('a-bob', 'dev-bob', 'A');
    const bystander = gateway('b-eve', 'dev-eve', 'B');
    const eveFrames: unknown[] = [];
    bystander.onMessage((m) => eveFrames.push(m));
    const connor2Frames: any[] = [];
    connorB.onMessage((m) => connor2Frames.push(m));

    const host = renderHook(() => useDocumentCall({
      documentId: 'doc-auth', gateway: connorA, platformApi: pa.platformApi, fetch: pa.fetchImpl,
      identity: { userId: 'dev-connor', displayName: 'Connor Hoehn' }, discoveryPollMs: 0,
    }));
    const onMissed = jest.fn();
    const alice = renderHook(() => useIncomingDocumentCalls({ gateway: aliceGw, localUserId: 'dev-alice' }));
    const bob = renderHook(() => useIncomingDocumentCalls({ gateway: bobGw, localUserId: 'dev-bob', onMissed }));
    await act(async () => { await pump(); });

    await act(async () => {
      await host.result.current.start({
        title: 'Auth architecture review', media: 'video', documentIds: ['doc-auth'], targetUserIds: ['dev-alice', 'dev-bob'],
        ring: true, micOn: true, cameraOn: true,
      });
      await pump();
    });
    expect(alice.result.current.current?.callId).toBe('sess-1');
    expect(bob.result.current.current?.callId).toBe('sess-1');
    // The ring's end comes from the server (60 s from now), not from arrival.
    expect(bob.result.current.current!.expiresAt - Date.now()).toBeLessThanOrEqual(60_000);
    // Connor's participant-state went to nobody outside the call.
    expect(eveFrames).toHaveLength(0);
    expect(c.A.router.broadcasts).toHaveLength(0);
    expect(c.B.router.broadcasts).toHaveLength(0);
    const row = (uid: string) => host.result.current.participants.find((p) => p.userId === uid);
    expect(row('dev-alice')?.state).toBe('ringing');
    expect(row('dev-bob')?.state).toBe('ringing');

    // Alice: Not now.
    await act(async () => { alice.result.current.decline('not-now'); await pump(); });
    expect(row('dev-alice')?.state).toBe('declined');
    expect(connor2Frames.some((f) => f.action === 'declined' && f.data.userId === 'dev-alice')).toBe(true);
    expect(c.wire.filter((w) => w.message.type === 'error')).toHaveLength(0);

    // Bob never answers: the sweep leader runs past the TTL.
    await act(async () => { await c.B.svc.runInviteSweep(Date.now() + 61_000); await pump(); });
    expect(row('dev-bob')?.state).toBe('missed');
    expect(connor2Frames.some((f) => f.action === 'invite-expired' && f.data.userId === 'dev-bob')).toBe(true);
    // Bob's popover closed on the server's word and reported a missed call.
    expect(bob.result.current.current).toBeNull();
    expect(onMissed).toHaveBeenCalledWith(expect.objectContaining({ callId: 'sess-1' }));
    expect(row('dev-alice')?.state).toBe('declined'); // still

    // Ring Bob again: back to ringing.
    await act(async () => { host.result.current.ringAgain('dev-bob'); await pump(); });
    expect(row('dev-bob')?.state).toBe('ringing');
    expect(bob.result.current.current?.callId).toBe('sess-1');

    host.unmount(); alice.unmount(); bob.unmount();
    await c.dispose();
  });

  it('no status echo: each person sends a bounded number of status frames and platform-api reads per join', async () => {
    const { c, pump, gateway, sentBy } = harness();
    // Platform-api answers, but never knows the call — the case where the old
    // active-call → refresh → status → active-call loop never settled.
    const paHost = makeFakePlatformApi();
    const paOthers = makeFakePlatformApi();
    const people = [
      { id: 'dev-connor', cid: 'a-connor', node: 'A' as const, pa: paHost },
      { id: 'dev-frank', cid: 'b-frank', node: 'B' as const, pa: paOthers },
      { id: 'dev-bob', cid: 'a-bob', node: 'A' as const, pa: paOthers },
      { id: 'dev-alice', cid: 'b-alice', node: 'B' as const, pa: paOthers },
    ];
    const hooks = new Map<string, ReturnType<typeof renderHook<ReturnType<typeof useDocumentCall>, unknown>>>();
    for (const p of people) {
      const gw = gateway(p.cid, p.id, p.node);
      hooks.set(p.id, renderHook(() => useDocumentCall({
        documentId: 'doc-auth', gateway: gw, platformApi: p.pa.platformApi, fetch: p.pa.fetchImpl,
        identity: { userId: p.id, displayName: p.id }, discoveryPollMs: 0,
      })));
    }
    await act(async () => { await pump(); });
    const host = hooks.get('dev-connor')!;
    await act(async () => {
      await host.result.current.start({
        title: 'T', media: 'video', documentIds: ['doc-auth'], targetUserIds: ['dev-frank', 'dev-bob', 'dev-alice'],
        ring: true, micOn: true, cameraOn: true,
      });
      await pump();
    });
    // Frank and Bob join, one after the other (each join pushes the roster to
    // whoever is still ringing → more active-call frames).
    for (const id of ['dev-frank', 'dev-bob']) {
      await act(async () => { await hooks.get(id)!.result.current.join('sess-1', { micOn: true, cameraOn: true }); await pump(); });
    }
    // A later roster change while Alice is still ringing.
    await act(async () => { await hooks.get('dev-frank')!.result.current.leave(); await pump(); });

    const statusCount = (cid: string) => (sentBy.get(cid) ?? []).filter((m) => m.service === 'call' && m.action === 'status').length;
    const docReads = (pa: ReturnType<typeof makeFakePlatformApi>) => pa.calls.filter((x) => x.method === 'GET').length;
    for (const p of people) {
      // One on mount; nothing echoes. (A reconnect or the discovery poll would add one each.)
      expect({ who: p.id, status: statusCount(p.cid) }).toEqual({ who: p.id, status: 1 });
    }
    // Three non-hosts share one fake platform-api. Per person at most: the
    // mount read (1 GET) + one read for the new call id + one on join (each
    // 2 GETs when the record is unknown) = 5 — single-flight + cooldown, not
    // one per active-call frame. The echo made this unbounded.
    expect(docReads(paOthers)).toBeLessThanOrEqual(3 * 5);
    expect(c.wire.filter((w) => w.message.type === 'error')).toHaveLength(0);
    for (const h of hooks.values()) h.unmount();
    await c.dispose();
  });
});
