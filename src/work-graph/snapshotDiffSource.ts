// realtime-modules/src/work-graph/snapshotDiffSource.ts
//
// `createSnapshotDiffSource` (0.147): the generic `WorkGraphSource` for a host
// that can rebuild a viewer's authorized snapshot but keeps no change log.
// Lifted from aws-agentcore's `lib/work-graph/stream.ts`, which every host
// otherwise copied (about 300 lines):
//
//   - For ONE subscriber, `frames` asks the host for that viewer's snapshot
//     now (`snapshot(sub)`), diffs it against the graph THAT subscription
//     last held, and emits one `delta` with the operations between them
//     (removed edges, removed nodes, upserted nodes, upserted edges, changed
//     source health — the order the reader's reducer applies). Nothing is
//     shared between viewers and the change itself is never sent.
//   - Catch-up on subscribe: the reader holds the snapshot its cursor names.
//     If the host can hand that snapshot back (`served(sub)`), the first
//     delta is computed from it; if the fresh snapshot carries the same
//     cursor, it is adopted silently; otherwise the reader is told to
//     refetch (`reset-required: gap`). A cursor should therefore be a
//     function of the snapshot's content (a hash), so an unchanged graph
//     yields the same cursor.
//   - Refusal: a rebuild the host refuses (it throws `WorkGraphSnapshotRefused`,
//     or anything `isRefusal` accepts — by default an error whose `status`
//     is 401 or 403) or a policy revision that moved ends the stream with a
//     content-free `invalidate: policy-changed`. A snapshot for another scope,
//     or `null`, ends it with `reset-required: scope-changed`. Any other
//     throw reaches the stream service, which answers
//     `reset-required: source-unavailable`.
//   - Bounds: more operations than one batch may carry is a `gap` (refetch);
//     a gap repeated within `gapWindowMs` for the same viewer and scope is
//     adopted instead, so a graph changing faster than a round trip cannot
//     loop the reader. Baselines are capped per connection and in total.
//
// Wire it as `workGraph({ channelFor, source: createSnapshotDiffSource({ snapshot }) })`
// and call `source.forgetClient(clientId)` when a socket goes away.

import type { AuthorityScope } from '../server-ws/authorityScope';
import {
    WORK_GRAPH_LIMITS,
    type ViewerWorkEdge,
    type ViewerWorkNode,
    type WorkGraphDeltaBatch,
    type WorkGraphDeltaOperation,
    type WorkGraphSnapshot,
    type WorkSourceStatus,
} from './contracts';
import type { WorkGraphSnapshotV2 } from './contractsV2';
import type { WorkGraphSource, WorkGraphStreamSubscription, WorkGraphStreamTrigger } from './streamService';
import { validateWorkGraphDeltaBatch } from './validation';

export type WorkGraphAnySnapshot = WorkGraphSnapshot | WorkGraphSnapshotV2;

/** Thrown by a host's `snapshot` when the viewer may no longer read this graph. */
export class WorkGraphSnapshotRefused extends Error {
    constructor(message = 'work graph snapshot refused') {
        super(message);
        this.name = 'WorkGraphSnapshotRefused';
    }
}

export interface SnapshotDiffSourceContext {
    trigger: WorkGraphStreamTrigger;
    /** The publish operation's AuthorityScope (share authorization reads under its contract). */
    scope: AuthorityScope;
}

export interface SnapshotDiffSourceOptions {
    /**
     * This subscriber's authorized snapshot NOW: the same builder the host's
     * snapshot route uses, for `sub.userContext` and `sub.scope` (and
     * `sub.activity` for a schemaVersion 2 reader). `null` means the scope no
     * longer exists (`reset-required: scope-changed`).
     */
    snapshot(sub: WorkGraphStreamSubscription, ctx: SnapshotDiffSourceContext): WorkGraphAnySnapshot | null | Promise<WorkGraphAnySnapshot | null>;
    /** Does `change` (the host's `publish` payload) concern this subscription? Default: yes. */
    concerns?(sub: WorkGraphStreamSubscription, change: unknown): boolean;
    /** Is this `snapshot` error a refusal (→ `invalidate`)? Default: `WorkGraphSnapshotRefused`, or `status` 401/403. */
    isRefusal?(error: unknown): boolean;
    /** The snapshot this viewer was served for `sub.cursor`, if the host kept it (the catch-up baseline). */
    served?(sub: WorkGraphStreamSubscription): WorkGraphAnySnapshot | null | undefined;
    /** The cursor a delta carries. Default: the fresh snapshot's own cursor. */
    cursorFor?(fresh: WorkGraphAnySnapshot, watermark: number): string;
    /** Live subscriptions remembered per connection. Default 8 (the stream service's cap). */
    maxPerClient?: number;
    /** Baselines remembered in total (oldest connection dropped first). Default 4096. */
    maxBaselines?: number;
    /** A repeated catch-up gap within this window is adopted, not re-sent. Default 30 000. */
    gapWindowMs?: number;
    /** Clock, injectable for tests. */
    now?: () => number;
}

export interface SnapshotDiffSource extends WorkGraphSource {
    frames(sub: WorkGraphStreamSubscription, trigger: WorkGraphStreamTrigger, opts: { scope: AuthorityScope }): Promise<readonly unknown[]>;
    /** A socket went away: forget every baseline its subscriptions held. */
    forgetClient(clientId: string): void;
    stats(): { clients: number; baselines: number; computed: number };
}

interface Baseline {
    watermark: number;
    policyRevision: string;
    nodes: Map<string, string>;
    edges: Map<string, string>;
    sources: Map<string, string>;
}

const sourceKey = ({ checkedAt: _checkedAt, ...rest }: WorkSourceStatus) => JSON.stringify(rest);

function baselineOf(snapshot: WorkGraphAnySnapshot, watermark = snapshot.watermark): Baseline {
    return {
        watermark,
        policyRevision: snapshot.scope.policyRevision,
        nodes: new Map(snapshot.nodes.map((n) => [n.id, JSON.stringify(n)])),
        edges: new Map(snapshot.edges.map((e) => [e.id, JSON.stringify(e)])),
        sources: new Map(snapshot.sources.map((s) => [s.source, sourceKey(s)])),
    };
}

function diffFromBaseline(base: Baseline, fresh: WorkGraphAnySnapshot): WorkGraphDeltaOperation[] {
    const ops: WorkGraphDeltaOperation[] = [];
    const nodes = new Map<string, ViewerWorkNode>(fresh.nodes.map((n) => [n.id, n]));
    const edges = new Map<string, ViewerWorkEdge>(fresh.edges.map((e) => [e.id, e]));
    for (const id of base.edges.keys()) if (!edges.has(id)) ops.push({ kind: 'remove-edge', edgeId: id });
    for (const id of base.nodes.keys()) if (!nodes.has(id)) ops.push({ kind: 'remove-node', nodeId: id });
    for (const [id, node] of nodes) if (base.nodes.get(id) !== JSON.stringify(node)) ops.push({ kind: 'upsert-node', node });
    for (const [id, edge] of edges) if (base.edges.get(id) !== JSON.stringify(edge)) ops.push({ kind: 'upsert-edge', edge });
    // A health line that only re-dates itself (`checkedAt`) is not a change.
    for (const source of fresh.sources) if (base.sources.get(source.source) !== sourceKey(source)) ops.push({ kind: 'source-health', source });
    return ops;
}

/**
 * The operations that turn `base` into `fresh`, in the order the reader's
 * reducer applies them. Node and edge equality is structural (JSON), so a
 * host should build records with a stable key order.
 */
export function diffWorkGraphSnapshots(base: WorkGraphAnySnapshot, fresh: WorkGraphAnySnapshot): WorkGraphDeltaOperation[] {
    return diffFromBaseline(baselineOf(base), fresh);
}

function sameScope(sub: WorkGraphStreamSubscription, fresh: WorkGraphAnySnapshot): boolean {
    const a = sub.scope, b = fresh.scope;
    return a.personId === b.personId && a.day === b.day && a.timezone === b.timezone && a.subject === b.subject;
}

function activityView(snapshot: WorkGraphAnySnapshot): Record<string, unknown> | null {
    if (snapshot.schemaVersion !== 2) return null;
    const { query, temporal, efforts, details, operations, eventBuckets } = snapshot as WorkGraphSnapshotV2;
    return { query, temporal, efforts, details, operations, eventBuckets };
}

function defaultRefusal(error: unknown): boolean {
    if (error instanceof WorkGraphSnapshotRefused) return true;
    const status = error !== null && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
    return status === 401 || status === 403;
}

export function createSnapshotDiffSource(options: SnapshotDiffSourceOptions): SnapshotDiffSource {
    if (!options || typeof options.snapshot !== 'function') throw new Error('createSnapshotDiffSource: snapshot(sub) is required');
    const isRefusal = options.isRefusal ?? defaultRefusal;
    const maxPerClient = options.maxPerClient ?? 8;
    const maxBaselines = options.maxBaselines ?? 4096;
    const gapWindowMs = options.gapWindowMs ?? 30_000;
    const now = options.now ?? Date.now;

    /** clientId → generation → the graph that subscription holds. */
    const baselines = new Map<string, Map<string, Baseline>>();
    let size = 0;
    /** client|scope → when a catch-up gap was last sent (bounds refetch loops). */
    const gaps = new Map<string, number>();
    let computed = 0;

    const get = (sub: WorkGraphStreamSubscription) => baselines.get(sub.clientId)?.get(sub.subscriptionGeneration);
    const set = (sub: WorkGraphStreamSubscription, baseline: Baseline) => {
        let subs = baselines.get(sub.clientId);
        if (!subs) { subs = new Map(); baselines.set(sub.clientId, subs); }
        if (!subs.has(sub.subscriptionGeneration)) size++;
        subs.delete(sub.subscriptionGeneration);
        subs.set(sub.subscriptionGeneration, baseline);
        // A reader that recovered opens a new generation; the oldest of the
        // same socket are over.
        while (subs.size > maxPerClient) { subs.delete(subs.keys().next().value!); size--; }
        while (size > maxBaselines) {
            const [clientId, oldest] = baselines.entries().next().value!;
            size -= oldest.size;
            baselines.delete(clientId);
        }
    };
    const drop = (sub: WorkGraphStreamSubscription) => {
        const subs = baselines.get(sub.clientId);
        if (subs?.delete(sub.subscriptionGeneration)) {
            size--;
            if (subs.size === 0) baselines.delete(sub.clientId);
        }
    };
    /** null the first time in a window (send the gap); else adopt `fresh` silently. */
    const gap = (sub: WorkGraphStreamSubscription, fresh: WorkGraphAnySnapshot): readonly unknown[] | null => {
        const key = JSON.stringify([sub.clientId, sub.scope.personId, sub.scope.day, sub.scope.timezone, sub.scope.subject ?? null]);
        const last = gaps.get(key);
        const at = now();
        if (last !== undefined && at - last < gapWindowMs) { set(sub, baselineOf(fresh)); return []; }
        gaps.set(key, at);
        if (gaps.size > 1024) gaps.delete(gaps.keys().next().value!);
        return null;
    };

    return {
        async frames(sub, trigger, opts) {
            const generation = sub.subscriptionGeneration;
            const invalidate = () => { drop(sub); return [{ kind: 'invalidate', subscriptionGeneration: generation, reason: 'policy-changed' }]; };
            const reset = (reason: 'gap' | 'scope-changed') => { drop(sub); return [{ kind: 'reset-required', subscriptionGeneration: generation, reason }]; };
            if (trigger.reason === 'change' && options.concerns && !options.concerns(sub, trigger.change)) return [];

            computed++;
            let fresh: WorkGraphAnySnapshot | null;
            try {
                fresh = await options.snapshot(sub, { trigger, scope: opts.scope });
            } catch (error) {
                if (isRefusal(error)) return invalidate();
                drop(sub);
                throw error; // the stream service answers reset-required: source-unavailable
            }
            if (!fresh || !sameScope(sub, fresh)) return reset('scope-changed');

            let from = get(sub);
            if (!from) {
                // Catch-up from the reader's snapshot cursor.
                const served = options.served?.(sub);
                if (served && served.cursor === sub.cursor && served.scope.policyRevision === fresh.scope.policyRevision) from = baselineOf(served);
                else if (fresh.cursor === sub.cursor) { set(sub, baselineOf(fresh)); return []; }
                else return gap(sub, fresh) ?? reset('gap');
            }
            if (from.policyRevision !== fresh.scope.policyRevision) return invalidate();
            const operations = diffFromBaseline(from, fresh);
            if (operations.length === 0) { set(sub, from); return []; }
            if (operations.length > WORK_GRAPH_LIMITS.deltaOperations) {
                // Too much for one batch: the reader refetches. A catch-up that
                // keeps overflowing is adopted; the next change reconciles it.
                return (trigger.reason === 'subscribe' ? gap(sub, fresh) : null) ?? reset('gap');
            }
            const watermark = Math.max(fresh.watermark, from.watermark + 1);
            const batch: WorkGraphDeltaBatch = {
                schemaVersion: 1,
                subscriptionGeneration: generation,
                previousWatermark: from.watermark,
                watermark,
                cursor: options.cursorFor ? options.cursorFor(fresh, watermark) : fresh.cursor,
                policyRevision: fresh.scope.policyRevision,
                operations,
            };
            if (!validateWorkGraphDeltaBatch(batch).ok) return reset('gap');
            set(sub, baselineOf(fresh, watermark));
            const view = sub.activity ? activityView(fresh) : null;
            return [{ kind: 'delta', batch: view ? { ...batch, schemaVersion: 2, view } : batch }];
        },
        forgetClient(clientId) {
            const subs = baselines.get(clientId);
            if (!subs) return;
            size -= subs.size;
            baselines.delete(clientId);
        },
        stats() {
            return { clients: baselines.size, baselines: size, computed };
        },
    };
}
