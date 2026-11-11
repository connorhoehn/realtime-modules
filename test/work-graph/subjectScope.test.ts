// 0.147 (G3b): a work graph scoped to a subject (`show:<id>`) with no day
// window, and `subject` nodes labelled by the host — through the contracts,
// the validators, the stream service, the gateway transport and the diff source.
import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { attachRealtime, workGraph, type RealtimeHandle } from '../../src/server';
import {
    createSnapshotDiffSource,
    type WorkGraphStreamScope,
    type WorkGraphStreamService,
} from '../../src/work-graph/server';
import {
    WORK_GRAPH_NO_DAY,
    bucketWorkEvents,
    isWorkGraphSubjectScope,
    validateWorkGraphQueryV2,
    validateWorkGraphSnapshot,
    validateWorkGraphSnapshotV2,
    workGraphSubjectScope,
    type ViewerWorkNode,
    type WorkGraphSnapshot,
} from '../../src/work-graph';
import { createWorkGraphGatewayTransport } from '../../src/client/work-graph/gatewayTransport';

const at = '2026-11-08T10:00:00.000Z';
const character = (id: string, extra: Partial<ViewerWorkNode> = {}): ViewerWorkNode => ({
    id, kind: 'subject', subjectKind: 'character', title: id, status: 'idle', disclosure: 'summary', updatedAt: at, capabilities: [], ...extra,
});
function showSnapshot(nodes: ViewerWorkNode[], cursor = `c${nodes.length}`, subject = 'show:moon'): WorkGraphSnapshot {
    return {
        schemaVersion: 1, scope: { ...workGraphSubjectScope(subject), policyRevision: 'r1' },
        revision: 1, watermark: 1, cursor, nodes, edges: [], sources: [], partial: false,
    };
}

describe('subject scope contracts (0.147)', () => {
    it('builds and recognises a subject scope', () => {
        expect(workGraphSubjectScope('show:moon')).toEqual({ personId: 'show:moon', subject: 'show:moon', day: '', timezone: '' });
        expect(WORK_GRAPH_NO_DAY).toBe('');
        expect(isWorkGraphSubjectScope(workGraphSubjectScope('show:moon'))).toBe(true);
        expect(isWorkGraphSubjectScope({ personId: 'p', day: '2026-11-08', timezone: 'UTC' })).toBe(false);
        expect(isWorkGraphSubjectScope({ personId: 'other', subject: 'show:moon', day: '', timezone: '' })).toBe(false);
    });

    it('validates a subject snapshot, and only that shape', () => {
        expect(validateWorkGraphSnapshot(showSnapshot([character('mina')])).ok).toBe(true);
        const bad = (scope: Record<string, unknown>) => validateWorkGraphSnapshot({ ...showSnapshot([]), scope: { policyRevision: 'r1', ...scope } }).ok;
        expect(bad({ personId: 'show:moon', subject: 'show:moon', day: '2026-11-08', timezone: 'UTC' })).toBe(false);
        expect(bad({ personId: 'person:1', subject: 'show:moon', day: '', timezone: '' })).toBe(false);
        expect(bad({ personId: 'show:moon', day: '', timezone: '' })).toBe(false);
        // Person-day snapshots are unchanged.
        expect(bad({ personId: 'p-1', day: '2026-11-08', timezone: 'UTC' })).toBe(true);
    });

    it('requires subjectKind on a subject node and forbids it elsewhere', () => {
        const withNode = (n: unknown) => validateWorkGraphSnapshot({ ...showSnapshot([]), nodes: [n] }).ok;
        expect(withNode(character('mina'))).toBe(true);
        expect(withNode(character('mina', { subjectKind: 'location' }))).toBe(true);
        expect(withNode({ ...character('mina'), subjectKind: undefined })).toBe(false);
        expect(withNode(character('mina', { subjectKind: 'Character!' }))).toBe(false);
        expect(withNode({ ...character('mina'), kind: 'task' })).toBe(false);
        const { subjectKind: _s, ...task } = { ...character('t'), kind: 'task' as const };
        expect(withNode(task)).toBe(true);
    });

    it('accepts a v2 subject query over any interval and buckets events across its window', () => {
        const query = { schemaVersion: 2, ...workGraphSubjectScope('show:moon'), windowStart: '2026-10-01T00:00:00.000Z', windowEnd: at, mode: 'live' };
        expect(validateWorkGraphQueryV2(query).ok).toBe(true);
        expect(validateWorkGraphQueryV2({ ...query, windowEnd: query.windowStart }).ok).toBe(false);
        expect(validateWorkGraphQueryV2({ ...query, day: '2026-11-08' }).ok).toBe(false);
        const buckets = bucketWorkEvents(query as any, [{ at: '2026-10-02T00:00:30.000Z' }, { at: '2026-09-30T00:00:00.000Z' }]);
        expect(buckets).toEqual([{ at: '2026-10-02T00:00:00.000Z', count: 1 }]);
        expect(() => bucketWorkEvents({ ...workGraphSubjectScope('show:moon') }, [])).toThrow(/window/);

        const v2 = {
            ...showSnapshot([character('mina')]), schemaVersion: 2, query,
            temporal: { mode: 'live', observedAt: at, coverage: { from: query.windowStart, through: at, complete: true } },
            efforts: [], details: [], operations: [], eventBuckets: buckets,
        };
        expect(validateWorkGraphSnapshotV2(v2).ok).toBe(true);
        // The query and the scope must name the same subject.
        expect(validateWorkGraphSnapshotV2({ ...v2, query: { ...query, ...workGraphSubjectScope('show:sun') } }).ok).toBe(false);
    });
});

describe('subject scope through the stream (0.147)', () => {
    type Sock = WebSocket & { frames: any[] };
    const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
    async function until(fn: () => boolean, timeoutMs = 2000): Promise<void> {
        const start = Date.now();
        while (!fn()) { if (Date.now() - start > timeoutMs) throw new Error('condition timeout'); await tick(5); }
    }

    it('maps { subject } to the subject scope and streams diffed deltas to the transport', async () => {
        let current = showSnapshot([character('mina')]);
        const source = createSnapshotDiffSource({ snapshot: () => current });
        const mapped: WorkGraphStreamScope[] = [];
        const server = http.createServer();
        const handle: RealtimeHandle = attachRealtime(server, {
            insecureAllowAll: true,
            features: [workGraph({
                source,
                channelFor: (scope) => { mapped.push(scope); return scope.subject ? `studio:graph:${scope.subject}` : null; },
            })],
            path: '/realtime',
            auth: async () => ({ userId: 'me' }),
            authorize: async () => true,
        } as any);
        const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
        const service = handle.services['work-graph'] as unknown as WorkGraphStreamService;

        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime`) as Sock;
        ws.frames = [];
        const handlers = new Set<(m: any) => void>();
        ws.on('message', (raw) => { const m = JSON.parse(String(raw)); ws.frames.push(m); for (const h of handlers) h(m); });
        const sent: any[] = [];
        await new Promise((r) => ws.on('open', r));
        const transport = createWorkGraphGatewayTransport({
            gateway: { send: (f) => { sent.push(f); ws.send(JSON.stringify(f)); }, onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); } },
            fetchSnapshot: async () => current,
        });
        const got: any[] = [];
        transport.openWebSocket({
            scope: { viewerId: 'me', ...workGraphSubjectScope('show:moon') }, cursor: current.cursor, subscriptionGeneration: 'g1',
            onMessage: (m) => got.push(m), onClose: () => undefined, onError: () => undefined,
        });
        // The wire names the subject alone; the service hands channelFor the full subject scope.
        expect(sent[0].scope).toEqual({ subject: 'show:moon' });
        await until(() => ws.frames.some((f) => f.action === 'subscribed'));
        expect(mapped).toEqual([workGraphSubjectScope('show:moon')]);

        current = showSnapshot([character('mina'), character('toby')]);
        await service.publish('studio:graph:show:moon', { cause: 'commit' });
        await until(() => got.length === 1);
        expect(got[0].batch.operations).toEqual([{ kind: 'upsert-node', node: character('toby') }]);

        // A malformed subject scope is refused.
        ws.send(JSON.stringify({ service: 'work-graph', action: 'subscribe', subscriptionGeneration: 'g2', cursor: 'c', scope: { subject: 'show:moon', day: '2026-11-08' } }));
        await until(() => ws.frames.some((f) => f.type === 'error' && f.subscriptionGeneration === 'g2'));

        ws.close();
        await handle.dispose();
        await new Promise<void>((r) => server.close(() => r()));
    });
});
