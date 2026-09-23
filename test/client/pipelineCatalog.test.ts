// realtime-modules/test/client/pipelineCatalog.test.ts
//
// The pure half of the pipelines directory: the enum, the row summary, the
// grouping and order, the status pill's text, and the rollup merge rule the
// browser shares with platform-api's run-rollup subscriber.

import { describe, expect, it } from '@jest/globals';
import {
  WORK_TYPE_ORDER,
  WORK_TYPE_LABEL,
  KIND_MARK,
  KIND_WORK_TYPE,
  ROLLUP_RECENT_LIMIT,
  summarize,
  summarizeAll,
  groupByWorkType,
  groupCatalog,
  statusPillFor,
  relativeTime,
  runEventFromFrame,
  applyRunEvent,
  mergeRunEvent,
  workTypeOf,
  kindOf,
} from '../../src/client/pipelines';
import type {
  PipelineCatalogEntry,
  PipelineRunRollup,
  PipelineRunRollupItem,
  RunItemStatus,
  PipelineKind,
} from '../../src/client/pipelines';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

function entry(over: Partial<PipelineCatalogEntry> & { id: string }): PipelineCatalogEntry {
  return {
    name: over.id,
    version: 1,
    status: 'published',
    createdAt: iso(10 * HOUR),
    updatedAt: iso(HOUR),
    createdBy: 'u1',
    rollup: null,
    ...over,
  };
}

function rollup(pipelineId: string, items: Array<[string, RunItemStatus, number]>, updatedAtAgo?: number): PipelineRunRollup {
  const recent: PipelineRunRollupItem[] = items.map(([runId, status, ago]) => ({
    runId, status, startedAt: iso(ago), at: iso(ago),
    ...(status === 'running' || status === 'awaiting_approval' || status === 'stuck' ? {} : { completedAt: iso(ago - 1000), at: iso(ago - 1000) }),
  }));
  const newest = recent[0];
  return {
    pipelineId,
    lastRunId: newest?.runId ?? '',
    lastRunAt: newest?.startedAt ?? '',
    lastRunStatus: newest?.status ?? 'completed',
    recent,
    failedOfRecent: recent.filter((r) => r.status === 'failed' || r.status === 'interrupted' || r.status === 'stuck').length,
    runningCount: recent.filter((r) => r.status === 'running' || r.status === 'awaiting_approval').length,
    runCount: recent.length,
    updatedAt: iso(updatedAtAgo ?? (items[0]?.[2] ?? 0)),
  };
}

describe('the enum', () => {
  it('maps every kind to a work type in the page order, and every kind to a mark', () => {
    expect(WORK_TYPE_ORDER).toEqual(['documents', 'agents', 'conversations', 'other']);
    expect(WORK_TYPE_LABEL.documents).toBe('Documents & presentations');
    const kinds = Object.keys(KIND_MARK) as PipelineKind[];
    expect(kinds).toHaveLength(10);
    for (const k of kinds) expect(WORK_TYPE_ORDER).toContain(KIND_WORK_TYPE[k]);
    expect(KIND_MARK.document).toBe('page');
    expect(KIND_WORK_TYPE.workflow).toBe('other');
  });

  it('infers a legacy definition: explicit work type wins, else the kind decides, else other/workflow', () => {
    expect(workTypeOf({ workType: 'conversations', kind: 'document' })).toBe('conversations');
    expect(workTypeOf({ kind: 'presentation' })).toBe('documents');
    expect(workTypeOf({})).toBe('other');
    expect(kindOf({ kind: 'call' })).toBe('call');
    expect(kindOf({ kind: 'bogus' as PipelineKind })).toBe('workflow');
  });
});

describe('summarize', () => {
  it('flattens the rollup into counts a row reads', () => {
    const e = entry({
      id: 'doc-edit', kind: 'document', route: ['/doc', 'Read', 'Plan', 'Approval', 'Suggestions'],
      readOnly: true,
      rollup: rollup('doc-edit', [['r5', 'awaiting_approval', 2 * MIN], ['r4', 'completed', 29 * MIN], ['r3', 'failed', HOUR], ['r2', 'completed', 2 * HOUR], ['r1', 'completed', 3 * HOUR]]),
    });
    const s = summarize(e);
    expect(s).toMatchObject({
      id: 'doc-edit', workType: 'documents', kind: 'document', mark: 'page', readOnly: true,
      lastRunId: 'r5', lastRunStatus: 'awaiting_approval',
      failedCount: 1, totalCount: 5, pendingApprovals: 1, runningCount: 1, rollupPending: false,
    });
    expect(s.route).toEqual(['/doc', 'Read', 'Plan', 'Approval', 'Suggestions']);
  });

  it('a pipeline with no rollup yet, and one with the sentinel row, both read as never run', () => {
    expect(summarize(entry({ id: 'a' }))).toMatchObject({ lastRunId: undefined, failedCount: 0, totalCount: 0, pendingApprovals: 0, rollupPending: true, route: [] });
    const sentinel = entry({ id: 'b', rollup: { pipelineId: 'b', lastRunId: '', lastRunAt: '', lastRunStatus: null, recent: [], failedOfRecent: 0, runningCount: 0, runCount: 0, updatedAt: iso(0) } });
    expect(summarize(sentinel)).toMatchObject({ lastRunId: undefined, lastRunStatus: undefined, totalCount: 0, rollupPending: false });
  });
});

describe('grouping', () => {
  const entries: PipelineCatalogEntry[] = [
    entry({ id: 'wf', kind: 'workflow', updatedAt: iso(5 * HOUR) }),
    entry({ id: 'call-notes', kind: 'call', rollup: rollup('call-notes', [['c1', 'completed', 3 * HOUR]]) }),
    entry({ id: 'deck', kind: 'presentation', updatedAt: iso(2 * HOUR) }),
    entry({ id: 'doc', kind: 'document', rollup: rollup('doc', [['d2', 'completed', 29 * MIN], ['d1', 'failed', 2 * HOUR]]) }),
    entry({ id: 'loop', kind: 'agent', status: 'draft', rollup: rollup('loop', [['l1', 'running', 10 * MIN]]) }),
    entry({ id: 'diagram', kind: 'diagram', rollup: rollup('diagram', [['g1', 'failed', 10 * HOUR]]) }),
    entry({ id: 'busy-doc', kind: 'document', rollup: rollup('busy-doc', [['b1', 'awaiting_approval', 6 * HOUR]]) }),
  ];

  it('orders groups by the enum, omits empty ones, and counts each', () => {
    const groups = groupByWorkType(summarizeAll(entries));
    expect(groups.map((g) => g.key)).toEqual(['documents', 'agents', 'conversations', 'other']);
    expect(groups.map((g) => g.label)).toEqual([
      'Documents & presentations', 'Agents & experiments', 'Conversations & media', 'Other',
    ]);
    expect(groups.map((g) => g.counts.total)).toEqual([4, 1, 1, 1]);
    expect(groups[0].counts).toEqual({ total: 4, failed: 2, running: 1, pendingApprovals: 1 });
    expect(groups[1].counts).toEqual({ total: 1, failed: 0, running: 1, pendingApprovals: 0 });
    expect(groups[0].workType).toBe('documents');
  });

  it('omits a group nobody is in', () => {
    const groups = groupByWorkType(summarizeAll(entries.filter((e) => e.kind !== 'call')));
    expect(groups.map((g) => g.key)).toEqual(['documents', 'agents', 'other']);
  });

  it('orders rows: in flight first, then newest run, then newest edit, then name', () => {
    const groups = groupByWorkType(summarizeAll(entries));
    expect(groups[0].entries.map((e) => e.id)).toEqual(['busy-doc', 'doc', 'diagram', 'deck']);
  });

  it('can group by kind or by definition status too', () => {
    expect(groupCatalog(summarizeAll(entries), 'kind').map((g) => g.key)).toEqual(['document', 'presentation', 'diagram', 'agent', 'call', 'workflow']);
    const byStatus = groupCatalog(summarizeAll(entries), 'status');
    expect(byStatus.map((g) => [g.key, g.label, g.counts.total])).toEqual([['published', 'Published', 6], ['draft', 'Draft', 1]]);
  });
});

describe('the status pill', () => {
  const pillFor = (over: Partial<PipelineCatalogEntry>) => statusPillFor(summarize(entry({ id: 'p', ...over })), NOW);

  it('reads the definition status when there is nothing to say about runs', () => {
    expect(pillFor({ status: 'published' })).toEqual({ tone: 'success', label: 'Published', text: 'Published' });
    expect(pillFor({ status: 'draft' })).toEqual({ tone: 'neutral', label: 'Draft', text: 'Draft' });
    expect(pillFor({ status: 'archived' })).toEqual({ tone: 'neutral', label: 'Archived', text: 'Archived' });
    expect(pillFor({ status: 'published', rollup: rollup('p', [['r1', 'completed', 29 * MIN]]) })).toMatchObject({ tone: 'success', text: 'Published' });
  });

  it('"1 of 5 failed · 29m ago" when an older recent run failed but the newest did not', () => {
    const r = rollup('p', [['r5', 'completed', 29 * MIN], ['r4', 'completed', HOUR], ['r3', 'failed', 2 * HOUR], ['r2', 'completed', 3 * HOUR], ['r1', 'completed', 4 * HOUR]]);
    expect(pillFor({ rollup: r })).toEqual({ tone: 'warning', label: '1 of 5 failed', meta: '29m ago', text: '1 of 5 failed · 29m ago' });
  });

  it('"Failed · 10h ago" when the newest run failed', () => {
    const r = rollup('p', [['r2', 'failed', 10 * HOUR], ['r1', 'completed', 12 * HOUR]]);
    expect(pillFor({ rollup: r })).toEqual({ tone: 'danger', label: 'Failed', meta: '10h ago', text: 'Failed · 10h ago' });
  });

  it('a run in flight is info, a stuck one warning, an interrupted one danger', () => {
    expect(pillFor({ rollup: rollup('p', [['r1', 'running', 3 * MIN]]) })).toMatchObject({ tone: 'info', text: 'Running · 3m ago' });
    expect(pillFor({ rollup: rollup('p', [['r1', 'awaiting_approval', 30_000]]) })).toMatchObject({ tone: 'info', text: 'Awaiting approval · just now' });
    expect(pillFor({ rollup: rollup('p', [['r1', 'stuck', 2 * HOUR]]) })).toMatchObject({ tone: 'warning', label: 'Stuck' });
    expect(pillFor({ rollup: rollup('p', [['r1', 'interrupted', 2 * HOUR]]) })).toMatchObject({ tone: 'danger', label: 'Interrupted' });
    expect(pillFor({ status: 'draft', rollup: rollup('p', [['r2', 'cancelled', MIN], ['r1', 'rejected', HOUR]]) })).toMatchObject({ tone: 'neutral', text: 'Draft' });
  });

  it('relative time reads like the host formatter', () => {
    expect(relativeTime(iso(5_000), NOW)).toBe('just now');
    expect(relativeTime(iso(29 * MIN), NOW)).toBe('29m ago');
    expect(relativeTime(iso(10 * HOUR), NOW)).toBe('10h ago');
    expect(relativeTime(iso(2 * 24 * HOUR), NOW)).toBe('2d ago');
    expect(relativeTime(undefined, NOW)).toBe('--');
    expect(relativeTime('nope', NOW)).toBe('--');
  });
});

describe('runEventFromFrame', () => {
  it('reads a lifecycle frame in either spelling and takes the payload stamp', () => {
    expect(runEventFromFrame({ type: 'pipeline:event', eventType: 'pipeline.run.completed', payload: { runId: 'r', pipelineId: 'p', completedAt: '2026-09-23T11:00:00.000Z' } }))
      .toEqual({ pipelineId: 'p', runId: 'r', status: 'completed', at: '2026-09-23T11:00:00.000Z', completedAt: '2026-09-23T11:00:00.000Z' });
    expect(runEventFromFrame({ type: 'pipeline:event', eventType: 'pipeline:run:started', payload: { runId: 'r', pipelineId: 'p', startedAt: '2026-09-23T10:00:00.000Z' } }))
      .toEqual({ pipelineId: 'p', runId: 'r', status: 'running', at: '2026-09-23T10:00:00.000Z', startedAt: '2026-09-23T10:00:00.000Z' });
  });

  it('falls back to the envelope, then to now', () => {
    expect(runEventFromFrame({ type: 'pipeline:event', eventType: 'pipeline.run.failed', payload: { runId: 'r', pipelineId: 'p' }, emittedAt: '2026-09-23T09:00:00.000Z' })?.at).toBe('2026-09-23T09:00:00.000Z');
    expect(runEventFromFrame({ type: 'pipeline:event', eventType: 'pipeline.run.failed', payload: { runId: 'r', pipelineId: 'p' } }, () => 'T')?.at).toBe('T');
  });

  it('ignores steps, tokens, other frame types, and frames that name no pipeline', () => {
    expect(runEventFromFrame({ type: 'pipeline:event', eventType: 'pipeline.step.completed', payload: { runId: 'r', pipelineId: 'p' } })).toBeUndefined();
    expect(runEventFromFrame({ type: 'pipeline:event', eventType: 'pipeline.llm.token', payload: { runId: 'r', pipelineId: 'p' } })).toBeUndefined();
    expect(runEventFromFrame({ type: 'chat:message', eventType: 'pipeline.run.completed', payload: { runId: 'r', pipelineId: 'p' } })).toBeUndefined();
    expect(runEventFromFrame({ type: 'pipeline:event', eventType: 'pipeline.run.completed', payload: { runId: 'r' } })).toBeUndefined();
    expect(runEventFromFrame(null)).toBeUndefined();
  });
});

describe('applyRunEvent — the merge rule', () => {
  const T = (ago: number) => iso(ago);

  it('a run.completed event updates the run in place and recomputes the counts', () => {
    const r = rollup('p', [['r2', 'running', 5 * MIN], ['r1', 'failed', HOUR]]);
    const next = applyRunEvent(r, { pipelineId: 'p', runId: 'r2', status: 'completed', at: T(MIN) })!;
    expect(next).not.toBe(r);
    expect(next.recent[0]).toMatchObject({ runId: 'r2', status: 'completed', startedAt: T(5 * MIN), completedAt: T(MIN) });
    expect(next).toMatchObject({ lastRunId: 'r2', lastRunStatus: 'completed', failedOfRecent: 1, runningCount: 0, updatedAt: T(MIN) });
  });

  it('a duplicate delivery (same run, same status) is a no-op — the same object comes back', () => {
    const r = rollup('p', [['r1', 'completed', HOUR]]);
    expect(applyRunEvent(r, { pipelineId: 'p', runId: 'r1', status: 'completed', at: T(30 * MIN) })).toBe(r);
  });

  it('an event older than what the run already has is ignored', () => {
    const r = rollup('p', [['r1', 'stuck', 10 * MIN]]);
    expect(applyRunEvent(r, { pipelineId: 'p', runId: 'r1', status: 'running', at: T(HOUR) })).toBe(r);
  });

  it('a run older than everything kept is history once the window is full, and is filed behind otherwise', () => {
    const full = rollup('p', [['r5', 'completed', MIN], ['r4', 'completed', 2 * MIN], ['r3', 'completed', 3 * MIN], ['r2', 'completed', 4 * MIN], ['r1', 'completed', 5 * MIN]]);
    expect(applyRunEvent(full, { pipelineId: 'p', runId: 'r0', status: 'completed', at: T(2 * HOUR), startedAt: T(2 * HOUR + MIN) })).toBe(full);
    const room = rollup('p', [['r2', 'completed', 10 * MIN], ['r1', 'completed', HOUR]]);
    const next = applyRunEvent(room, { pipelineId: 'p', runId: 'r0', status: 'completed', at: T(2 * HOUR) });
    expect(next.recent.map((x) => x.runId)).toEqual(['r2', 'r1', 'r0']);
    expect(next).toMatchObject({ lastRunId: 'r2', runCount: 3, updatedAt: room.updatedAt });
  });

  it('a late `started` cannot reopen a finished run', () => {
    const r = rollup('p', [['r1', 'completed', HOUR]]);
    expect(applyRunEvent(r, { pipelineId: 'p', runId: 'r1', status: 'running', at: T(MIN) })).toBe(r);
  });

  it('a failed → stuck → completed run ends completed and no longer counts as failed', () => {
    let r = applyRunEvent(null, { pipelineId: 'p', runId: 'r1', status: 'running', at: T(HOUR) })!;
    r = applyRunEvent(r, { pipelineId: 'p', runId: 'r1', status: 'stuck', at: T(30 * MIN) })!;
    expect(r).toMatchObject({ lastRunStatus: 'stuck', failedOfRecent: 1, runningCount: 0 });
    r = applyRunEvent(r, { pipelineId: 'p', runId: 'r1', status: 'completed', at: T(MIN) })!;
    expect(r).toMatchObject({ lastRunStatus: 'completed', failedOfRecent: 0, runningCount: 0 });
  });

  it('starts a rollup from nothing, keeps it newest-first, and caps recent at 5', () => {
    let r: PipelineRunRollup | null = null;
    for (let i = 0; i < 7; i += 1) {
      r = applyRunEvent(r, { pipelineId: 'p', runId: `r${i}`, status: 'running', at: T((7 - i) * MIN) });
    }
    expect(r!.recent).toHaveLength(ROLLUP_RECENT_LIMIT);
    expect(r!.recent.map((x) => x.runId)).toEqual(['r6', 'r5', 'r4', 'r3', 'r2']);
    expect(r!).toMatchObject({ lastRunId: 'r6', lastRunAt: T(MIN), runningCount: 5, failedOfRecent: 0, runCount: 7 });
  });

  it('a run first seen by its terminal event is inserted with the start time the payload carried', () => {
    const r = applyRunEvent(rollup('p', [['r1', 'completed', 2 * HOUR]]), { pipelineId: 'p', runId: 'r2', status: 'failed', at: T(MIN), startedAt: T(5 * MIN) })!;
    expect(r.recent[0]).toEqual({ runId: 'r2', status: 'failed', startedAt: T(5 * MIN), completedAt: T(MIN), at: T(MIN) });
    expect(r).toMatchObject({ lastRunId: 'r2', lastRunStatus: 'failed', failedOfRecent: 1 });
  });

  it('an event for another pipeline leaves the rollup alone', () => {
    const r = rollup('p', [['r1', 'completed', HOUR]]);
    expect(applyRunEvent(r, { pipelineId: 'q', runId: 'x', status: 'running', at: T(0) })).toBe(r);
  });

  it('a completed event whose payload says rejected is a rejection; a paused or queued run is live', () => {
    expect(runEventFromFrame({ type: 'pipeline:event', eventType: 'pipeline.run.completed', payload: { runId: 'r', pipelineId: 'p', status: 'rejected', at: T(MIN) } }))
      .toEqual({ pipelineId: 'p', runId: 'r', status: 'rejected', at: T(MIN) });
    const r = applyRunEvent(null, { pipelineId: 'p', runId: 'r', status: 'pending', at: T(MIN) });
    expect(r).toMatchObject({ lastRunStatus: 'pending', runningCount: 1, runCount: 1 });
    expect(statusPillFor(summarize(entry({ id: 'p', rollup: r })), NOW)).toMatchObject({ tone: 'info', text: 'Queued · 1m ago' });
    const paused = applyRunEvent(r, { pipelineId: 'p', runId: 'r', status: 'paused_at_breakpoint', at: T(30_000) });
    expect(statusPillFor(summarize(entry({ id: 'p', rollup: paused })), NOW)).toMatchObject({ tone: 'info', label: 'Paused' });
  });
});

describe('mergeRunEvent', () => {
  it('touches only the entry the event names and keeps the array identity when nothing changed', () => {
    const a = entry({ id: 'a', rollup: rollup('a', [['a1', 'completed', HOUR]]) });
    const b = entry({ id: 'b', rollup: rollup('b', [['b1', 'running', 5 * MIN]]) });
    const list = [a, b];
    const next = mergeRunEvent(list, { pipelineId: 'b', runId: 'b1', status: 'completed', at: iso(MIN) });
    expect(next).not.toBe(list);
    expect(next[0]).toBe(a);
    expect(next[1]).not.toBe(b);
    expect(next[1].rollup).toMatchObject({ lastRunStatus: 'completed', runningCount: 0 });
    expect(mergeRunEvent(next, { pipelineId: 'zzz', runId: 'z', status: 'running', at: iso(0) })).toBe(next);
    expect(mergeRunEvent(next, { pipelineId: 'b', runId: 'b1', status: 'completed', at: iso(MIN) })).toBe(next);
  });
});
