// 0.147: createSnapshotDiffSource — rebuild the subscriber's snapshot, diff it
// against the graph that subscription holds, emit the delta, invalidate on
// refusal (the generic form of aws-agentcore's lib/work-graph/stream.ts).
import { describe, it, expect, jest } from '@jest/globals';
import {
    createSnapshotDiffSource,
    diffWorkGraphSnapshots,
    WorkGraphSnapshotRefused,
    type WorkGraphStreamSubscription,
} from '../../src/work-graph/server';
import {
    WORK_GRAPH_LIMITS,
    workGraphSubjectScope,
    validateWorkGraphDeltaBatch,
    type ViewerWorkEdge,
    type ViewerWorkNode,
    type WorkGraphSnapshot,
} from '../../src/work-graph';
import { createAuthorityScope } from '../../src/server-ws/authorityScope';

const SUBJECT = workGraphSubjectScope('show:moon');
const at = '2026-11-08T10:00:00.000Z';
const node = (id: string, extra: Partial<ViewerWorkNode> = {}): ViewerWorkNode => ({
    id, kind: 'subject', subjectKind: 'character', title: id, status: 'idle', disclosure: 'summary', updatedAt: at, capabilities: [], ...extra,
});
const edge = (id: string, fromId: string, toId: string): ViewerWorkEdge => ({
    id, fromId, toId, relation: 'derived-from', status: 'idle', disclosure: 'summary', updatedAt: at, capabilities: [],
});
function snap(nodes: ViewerWorkNode[], edges: ViewerWorkEdge[] = [], watermark = 1, policyRevision = 'r1', scope = SUBJECT): WorkGraphSnapshot {
    return {
        schemaVersion: 1,
        scope: { ...scope, policyRevision },
        revision: watermark, watermark,
        cursor: `c:${policyRevision}:${JSON.stringify([nodes, edges])}`.slice(0, 200),
        nodes, edges, sources: [], partial: false,
    };
}
const sub = (cursor: string, extra: Partial<WorkGraphStreamSubscription> = {}): WorkGraphStreamSubscription => ({
    clientId: 'c1', userContext: { userId: 'u1' }, channel: 'studio:graph:moon', scope: SUBJECT,
    subscriptionGeneration: 'g1', cursor, ...extra,
});
const scope = () => ({ scope: createAuthorityScope('test') });
const change = { reason: 'change' as const, change: { cause: 'commit' } };

describe('createSnapshotDiffSource (0.147)', () => {
    it('diffs in reducer order: removed edges, removed nodes, upserted nodes, upserted edges', () => {
        const base = snap([node('a'), node('b')], [edge('e1', 'a', 'b')]);
        const fresh = snap([node('a', { title: 'A2' }), node('c')], [edge('e2', 'a', 'c')]);
        expect(diffWorkGraphSnapshots(base, fresh).map((op) => op.kind + ':' + ('edgeId' in op ? op.edgeId : 'nodeId' in op ? op.nodeId : 'node' in op ? op.node.id : 'edge' in op ? op.edge.id : '')))
            .toEqual(['remove-edge:e1', 'remove-node:b', 'upsert-node:a', 'upsert-node:c', 'upsert-edge:e2']);
        expect(diffWorkGraphSnapshots(base, base)).toEqual([]);
    });

    it('adopts the reader snapshot on subscribe, then emits one valid delta per change', async () => {
        let current = snap([node('mina')]);
        const snapshot = jest.fn(async () => current);
        const source = createSnapshotDiffSource({ snapshot });
        const s0 = sub(current.cursor);
        expect(await source.frames(s0, { reason: 'subscribe' }, scope())).toEqual([]);

        current = snap([node('mina', { status: 'running' }), node('toby')], [], 1);
        const frames = await source.frames(sub(current.cursor), change, scope()) as any[];
        expect(frames).toHaveLength(1);
        expect(frames[0].kind).toBe('delta');
        const batch = frames[0].batch;
        expect(validateWorkGraphDeltaBatch(batch).ok).toBe(true);
        // The fresh watermark did not move: the delta still advances it.
        expect([batch.previousWatermark, batch.watermark]).toEqual([1, 2]);
        expect(batch.cursor).toBe(current.cursor);
        expect(batch.operations.map((op: any) => op.node.id)).toEqual(['mina', 'toby']);

        // Nothing changed: nothing sent.
        expect(await source.frames(sub(current.cursor), change, scope())).toEqual([]);
        expect(source.stats()).toEqual({ clients: 1, baselines: 1, computed: 3 });
        source.forgetClient('c1');
        expect(source.stats().baselines).toBe(0);
    });

    it('catches up from a served snapshot; an unknown cursor is a gap, and a repeated gap is adopted', async () => {
        const old = snap([node('mina')]);
        const fresh = snap([node('mina'), node('toby')], [], 3);
        let now = 1_000;
        const source = createSnapshotDiffSource({ snapshot: () => fresh, served: (s) => (s.cursor === old.cursor ? old : null), now: () => now });
        const caught = await source.frames(sub(old.cursor), { reason: 'subscribe' }, scope()) as any[];
        expect(caught[0].batch.operations).toEqual([{ kind: 'upsert-node', node: node('toby') }]);
        expect(caught[0].batch.previousWatermark).toBe(1);

        const stray = { ...sub('c:unknown'), subscriptionGeneration: 'g2' };
        expect(await source.frames(stray, { reason: 'subscribe' }, scope())).toEqual([{ kind: 'reset-required', subscriptionGeneration: 'g2', reason: 'gap' }]);
        now += 1_000;
        const again = { ...stray, subscriptionGeneration: 'g3' };
        expect(await source.frames(again, { reason: 'subscribe' }, scope())).toEqual([]);
        // Adopted: the next change diffs from the fresh graph.
        expect(await source.frames(again, change, scope())).toEqual([]);
    });

    it('invalidates on a refused rebuild or a moved policy revision', async () => {
        let current = snap([node('mina')]);
        let refuse: unknown = null;
        const source = createSnapshotDiffSource({ snapshot: () => { if (refuse) throw refuse; return current; } });
        await source.frames(sub(current.cursor), { reason: 'subscribe' }, scope());

        refuse = new WorkGraphSnapshotRefused();
        expect(await source.frames(sub(current.cursor), change, scope())).toEqual([{ kind: 'invalidate', subscriptionGeneration: 'g1', reason: 'policy-changed' }]);
        expect(source.stats().baselines).toBe(0);

        refuse = null;
        await source.frames(sub(current.cursor), { reason: 'subscribe' }, scope());
        refuse = Object.assign(new Error('forbidden'), { status: 403 });
        expect((await source.frames(sub(current.cursor), change, scope()) as any[])[0].kind).toBe('invalidate');

        refuse = null;
        await source.frames(sub(current.cursor), { reason: 'subscribe' }, scope());
        current = snap([node('mina')], [], 2, 'r2');
        expect((await source.frames(sub(current.cursor), change, scope()) as any[])[0]).toEqual({ kind: 'invalidate', subscriptionGeneration: 'g1', reason: 'policy-changed' });
    });

    it('resets on a missing or foreign scope, rethrows outages, and skips changes that do not concern the subscription', async () => {
        const mine = snap([node('mina')]);
        const other = snap([node('x')], [], 1, 'r1', workGraphSubjectScope('show:sun'));
        let answer: any = null;
        const concerns = jest.fn((s: WorkGraphStreamSubscription, c: unknown) => (c as { show?: string }).show !== 'sun');
        const source = createSnapshotDiffSource({ snapshot: () => { if (answer instanceof Error) throw answer; return answer; }, concerns });
        expect(await source.frames(sub(mine.cursor), { reason: 'subscribe' }, scope())).toEqual([{ kind: 'reset-required', subscriptionGeneration: 'g1', reason: 'scope-changed' }]);
        answer = other;
        expect((await source.frames(sub(mine.cursor), { reason: 'subscribe' }, scope()) as any[])[0].reason).toBe('scope-changed');
        answer = new Error('db down');
        await expect(source.frames(sub(mine.cursor), { reason: 'subscribe' }, scope())).rejects.toThrow('db down');
        const before = source.stats().computed;
        expect(await source.frames(sub(mine.cursor), { reason: 'change', change: { show: 'sun' } }, scope())).toEqual([]);
        expect(source.stats().computed).toBe(before);
    });

    it('sends a gap when one batch cannot carry the change, and attaches the v2 view for an activity reader', async () => {
        let current = snap([node('mina')]);
        const source = createSnapshotDiffSource({ snapshot: () => current });
        await source.frames(sub(current.cursor), { reason: 'subscribe' }, scope());
        current = snap(Array.from({ length: WORK_GRAPH_LIMITS.deltaOperations + 1 }, (_, i) => node(`n${i}`)));
        expect(await source.frames(sub('x'), change, scope())).toEqual([{ kind: 'reset-required', subscriptionGeneration: 'g1', reason: 'gap' }]);

        const v1 = snap([node('mina')]);
        const view = { query: { q: 1 }, temporal: { t: 1 }, efforts: [], details: [], operations: [], eventBuckets: [] };
        let v2: any = { ...v1, schemaVersion: 2, ...view };
        const activity = { schemaVersion: 2 as const, windowStart: at, windowEnd: at, mode: 'live' as const };
        const reader = createSnapshotDiffSource({ snapshot: () => v2 });
        await reader.frames(sub(v1.cursor, { activity }), { reason: 'subscribe' }, scope());
        v2 = { ...snap([node('mina'), node('toby')]), schemaVersion: 2, ...view };
        const [frame] = await reader.frames(sub(v1.cursor, { activity }), change, scope()) as any[];
        expect(frame.batch.schemaVersion).toBe(2);
        expect(frame.batch.view).toEqual(view);
    });

    it('requires a snapshot function', () => {
        expect(() => createSnapshotDiffSource({} as any)).toThrow(/snapshot/);
    });
});
