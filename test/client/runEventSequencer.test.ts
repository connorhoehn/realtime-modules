import { RunEventSequencer, type SequencedFrame } from '../../src/client/pipelines/runEventSequencer';

type F = SequencedFrame & { eventType: string };
const f = (runSeq: number, eventType = 'pipeline.step.started', runId = 'r1'): F =>
  ({ eventType, payload: { runId, runSeq, pipelineId: 'p1' }, emittedAt: 1000 });

function harness(extra: Record<string, unknown> = {}) {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number; live: boolean }> = [];
  let ids = 0;
  const out: F[] = [];
  const gaps: unknown[] = [];
  const s = new RunEventSequencer<F>({
    deliver: (x) => out.push(x),
    onGap: (g) => gaps.push(g),
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, id: ++ids, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { live: boolean }).live = false; },
    ...extra,
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at; due.live = false; due.fn();
    }
    now = until;
  };
  const seqs = () => out.map((x) => `${(x.payload as { runSeq: number }).runSeq}${x.eventType === 'pipeline.run.started' ? 's' : ''}`);
  return { s, out, gaps, advance, seqs };
}

describe('RunEventSequencer (Loop 30)', () => {
  it('releases in-order frames immediately and never arms a timer', () => {
    const h = harness();
    h.s.push(f(1, 'pipeline.run.started')); h.s.push(f(2)); h.s.push(f(3));
    expect(h.seqs()).toEqual(['1s', '2', '3']);
    expect(h.s.reordered).toBe(0);
  });

  it('holds only across a real gap and drains when it fills', () => {
    const h = harness();
    h.s.push(f(2)); h.s.push(f(3));
    expect(h.out).toHaveLength(0);
    h.advance(40);
    h.s.push(f(1, 'pipeline.run.started'));
    expect(h.seqs()).toEqual(['1s', '2', '3']);
    h.advance(1000);
    expect(h.gaps).toHaveLength(0);
  });

  it('times out at the 150 ms cap, synthesizes run.started first, asks for a resync', () => {
    const h = harness();
    h.s.push(f(2)); h.s.push(f(3));
    h.advance(149);
    expect(h.out).toHaveLength(0);
    h.advance(1);
    expect(h.seqs()).toEqual(['1s', '2', '3']);
    expect((h.out[0]!.payload as { synthesized?: boolean }).synthesized).toBe(true);
    expect(h.gaps).toEqual([{ runId: 'r1', pipelineId: 'p1', missing: [1], synthesizedStart: true }]);
    // The real start lands late: delivered, not swallowed.
    h.s.push(f(1, 'pipeline.run.started'));
    expect(h.seqs()).toEqual(['1s', '2', '3', '1s']);
    expect(h.s.late).toBe(1);
  });

  it('a mid-run gap releases in order without a synthesized start', () => {
    const h = harness();
    h.s.push(f(1, 'pipeline.run.started')); h.s.push(f(3)); h.s.push(f(4));
    h.advance(150);
    expect(h.seqs()).toEqual(['1s', '3', '4']);
    expect(h.gaps).toEqual([{ runId: 'r1', pipelineId: 'p1', missing: [2], synthesizedStart: false }]);
    h.s.push(f(5));
    expect(h.seqs()).toEqual(['1s', '3', '4', '5']);
  });

  it('adapts the wait to how fast gaps fill, within bounds', () => {
    const h = harness();
    expect(h.s.gapWaitMs()).toBe(150);
    for (let i = 0; i < 6; i += 1) {
      const run = `a${i}`;
      h.s.push(f(2, 'pipeline.step.started', run));
      h.advance(10);
      h.s.push(f(1, 'pipeline.run.started', run));
    }
    expect(h.s.gapWaitMs()).toBe(25); // p95 10 ms × 1.5 + 10
    const slow = harness({ minGapMs: 20, maxGapMs: 150 });
    for (let i = 0; i < 6; i += 1) {
      const run = `b${i}`;
      slow.s.push(f(2, 'pipeline.step.started', run));
      slow.advance(140);
      slow.s.push(f(1, 'pipeline.run.started', run));
    }
    expect(slow.s.gapWaitMs()).toBe(150);
  });

  it('passes unnumbered frames straight through and honours a fixed gapMs', () => {
    const h = harness({ gapMs: 400 });
    h.s.push({ eventType: 'pipeline.llm.token', payload: { runId: 'r1' } });
    h.s.push(f(2));
    h.advance(399);
    expect(h.out).toHaveLength(1);
    h.advance(1);
    expect(h.out).toHaveLength(3);
  });
});
