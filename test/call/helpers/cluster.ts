// Two-replica harness for CallService tests. Each "node" has its own router
// (which clients are local) but they share one FakeRedis (the cluster's
// state), one pub/sub bus and one delivery wire, so a frame sent by node A
// to a client on node B lands on the wire exactly as the gateway's
// websocket:direct:<nodeId> relay would deliver it.

import { CallService } from '../../../src/call/CallService';
import { RedisCallStateStore, RedisDocumentCallMetaStore } from '../../../src/call/CallStateStore';
import type { CallMessageRouter, CallServiceOptions } from '../../../src/call/types';
import { FakeRedis } from './fakeRedis';

export class NoopLogger {
  debug() {/* noop */}
  info() {/* noop */}
  warn() {/* noop */}
  error() {/* noop */}
}

export interface Sent { clientId: string; message: any; via: string }

export const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeBus() {
  const handlers = new Map<string, Set<(p: string) => void>>();
  return {
    publish(topic: string, payload: string) {
      for (const h of handlers.get(topic) ?? []) h(payload);
    },
    subscribe(topic: string, h: (p: string) => void) {
      let s = handlers.get(topic);
      if (!s) { s = new Set(); handlers.set(topic, s); }
      s.add(h);
      return () => { s!.delete(h); };
    },
  };
}

/** clientId → { userId, node } for every connected client in the cluster. */
export type Directory = Map<string, { userId: string; node: string }>;

export function makeNodeRouter(node: string, dir: Directory, wire: Sent[]) {
  const router: CallMessageRouter & { broadcasts: unknown[] } = {
    broadcasts: [],
    sendToClient(clientId: string, message: unknown) {
      if (!dir.has(clientId)) return false;
      wire.push({ clientId, message, via: node });
      return true;
    },
    broadcastToAll(message: unknown) { router.broadcasts.push(message); },
    getClientsByUserId(userIds: string[], exclude: string) {
      const out: Array<{ clientId: string; userId: string; nodeId: string }> = [];
      for (const [cid, v] of dir) {
        if (cid !== exclude && userIds.includes(v.userId)) out.push({ clientId: cid, userId: v.userId, nodeId: v.node });
      }
      return out;
    },
    getUserIdForClient(clientId: string) {
      const v = dir.get(clientId);
      return v && v.node === node ? v.userId : null;
    },
    isClientLive(clientId: string) {
      const v = dir.get(clientId);
      if (!v) return null;
      return v.node === node ? true : null;
    },
  } as any;
  return router;
}

export function makeCluster(opts: Partial<CallServiceOptions> & { leader?: 'A' | 'B' | 'both' } = {}) {
  const redis = new FakeRedis();
  const bus = makeBus();
  const dir: Directory = new Map();
  const wire: Sent[] = [];
  const leader = opts.leader ?? 'both';
  const make = (node: 'A' | 'B') => {
    const router = makeNodeRouter(node, dir, wire);
    const svc = new CallService({
      messageRouter: router,
      logger: new NoopLogger() as any,
      stateStore: new RedisCallStateStore(redis as any),
      metaStore: new RedisDocumentCallMetaStore(redis as any),
      crossNodePubSub: bus,
      sweeperIsLeader: () => leader === 'both' || leader === node,
      ...opts,
    });
    return { svc, router };
  };
  const A = make('A');
  const B = make('B');
  return {
    redis, dir, wire, A, B,
    connect(clientId: string, userId: string, node: 'A' | 'B') { dir.set(clientId, { userId, node }); },
    drop(clientId: string) { dir.delete(clientId); },
    frames(clientId: string, action?: string) {
      return wire.filter((w) => w.clientId === clientId && (!action || w.message?.action === action)).map((w) => w.message);
    },
    async dispose() { await A.svc.dispose(); await B.svc.dispose(); },
  };
}
