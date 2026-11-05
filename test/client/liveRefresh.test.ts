// realtime-modules/test/client/liveRefresh.test.ts
//
// createLiveRefresh (0.145.0), ported from the aws-agentcore portal's
// flowRunFollower tests (portal/src/hooks/__tests__/flowRunFollower.test.ts)
// and pollSchedule's backoff, on a manual clock and timer queue.

import { describe, expect, it } from '@jest/globals';
import {
  createLiveRefresh,
  liveRefreshDelay,
  DEFAULT_LIVE_REFRESH_LIVE_POLL_MS,
  DEFAULT_LIVE_REFRESH_POLL_MS,
} from '../../src/client/liveRefresh';
import type { LiveRefreshOptions } from '../../src/client/liveRefresh';

type R = { status: string; n?: number };

/** A manual clock and timer queue; reads resolve when the test says so. */
function harness(over: Partial<LiveRefreshOptions<R>> = {}) {
  let t = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const pending: Array<{ resolve: (r: R) => void; reject: (e: Error) => void; signal: AbortSignal }> = [];
  const updates: R[] = [];
  const errors: string[] = [];
  const f = createLiveRefresh<R>({
    read: (signal) => new Promise<R>((resolve, reject) => { pending.push({ resolve, reject, signal }); }),
    timers: {
      setTimeout: (fn, ms) => { const id = nextId++; timers.push({ at: t + ms, fn, id }); return id; },
      clearTimeout: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
    },
    now: () => t,
    hidden: false,
    onData: (r) => updates.push(r),
    onError: (e) => errors.push((e as Error).message),
    ...over,
  });
  const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
  return {
    f, updates, errors, pending, timers,
    get now() { return t; },
    /** Resolve the oldest outstanding read. */
    async answer(r: R | Error) {
      const p = pending.shift();
      if (!p) throw new Error('no read is outstanding');
      if (r instanceof Error) p.reject(r); else p.resolve(r);
      await flush();
    },
    /** Advance to the next timer and fire it. Returns the delay waited. */
    async tick() {
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (!next) throw new Error('no timer is scheduled');
      const waited = next.at - t; t = next.at; next.fn(); await flush();
      return waited;
    },
    advance(ms: number) { t += ms; },
  };
}

describe('liveRefreshDelay (pollSchedule.nextPollDelay)', () => {
  it('doubles per consecutive failure, capped at 5x; a success (0) is the base', () => {
    expect(liveRefreshDelay(0, 1000)).toBe(1000);
    expect(liveRefreshDelay(1, 1000)).toBe(2000);
    expect(liveRefreshDelay(2, 1000)).toBe(4000);
    expect(liveRefreshDelay(3, 1000)).toBe(5000);
    expect(liveRefreshDelay(50, 1000)).toBe(5000);
  });
  it('a lower cap holds; a cap above 5 is clamped to 5, below 1 to 1', () => {
    expect(liveRefreshDelay(3, 1000, 3)).toBe(3000);
    expect(liveRefreshDelay(9, 1000, 100)).toBe(5000);
    expect(liveRefreshDelay(9, 1000, 0)).toBe(1000);
  });
  it('a non-positive or non-finite base comes back as is', () => {
    expect(liveRefreshDelay(3, 0)).toBe(0);
    expect(liveRefreshDelay(3, -5)).toBe(-5);
    expect(liveRefreshDelay(Number.NaN, 1000)).toBe(1000);
  });
});

describe('createLiveRefresh', () => {
  it('defaults: 5 s offline, 30 s live', async () => {
    const h = harness({ pollMs: undefined });
    await h.answer({ status: 'a' });
    expect(h.timers[0]!.at).toBe(DEFAULT_LIVE_REFRESH_POLL_MS);
    h.f.setLive(true);
    await h.answer({ status: 'b' });
    expect(h.timers[0]!.at).toBe(DEFAULT_LIVE_REFRESH_LIVE_POLL_MS);
  });

  it('offline: polls on pollMs, backs off a failure, resets on success', async () => {
    const h = harness({ pollMs: 100 });
    await h.answer(new Error('net'));
    expect(await h.tick()).toBe(200); // one failure doubles
    await h.answer(new Error('net'));
    expect(await h.tick()).toBe(400);
    await h.answer(new Error('net'));
    expect(await h.tick()).toBe(500); // capped at 5x
    await h.answer({ status: 'ok' });
    expect(await h.tick()).toBe(100); // success resets
    expect(h.errors).toEqual(['net', 'net', 'net']);
    expect(h.f.failures).toBe(0);
  });

  it('maxBackoff lowers the ceiling', async () => {
    const h = harness({ pollMs: 100, maxBackoff: 2 });
    await h.answer(new Error('x'));
    expect(await h.tick()).toBe(200);
    await h.answer(new Error('x'));
    expect(await h.tick()).toBe(200);
  });

  it('live: a hint re-reads at once; only the safety read is scheduled', async () => {
    const h = harness({ pollMs: 100 });
    await h.answer({ status: 'queued' });
    h.f.setLive(true); // catch-up read on becoming live
    await h.answer({ status: 'queued', n: 1 });
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.at).toBe(30_000);
    h.f.hint();
    await h.answer({ status: 'running' });
    h.f.hint();
    await h.answer({ status: 'done' });
    expect(h.updates.map((u) => u.status)).toEqual(['queued', 'queued', 'running', 'done']);
  });

  it('catch-up: becoming live reads once, even before the offline poll is due', async () => {
    const h = harness({ pollMs: 10_000 });
    await h.answer({ status: 'a' });
    expect(h.pending).toHaveLength(0);
    h.f.setLive(true);
    expect(h.pending).toHaveLength(1);
    h.f.setLive(true); // no change: no second read
    expect(h.pending).toHaveLength(1);
  });

  it('livePollMs 0 turns the live safety read off; a failure still retries on pollMs', async () => {
    const h = harness({ pollMs: 100, livePollMs: 0, live: true });
    await h.answer({ status: 'a' });
    expect(h.timers).toHaveLength(0);
    h.f.hint();
    await h.answer(new Error('down'));
    expect(await h.tick()).toBe(200);
  });

  it('pollMs 0 turns offline polling off', async () => {
    const h = harness({ pollMs: 0 });
    await h.answer({ status: 'a' });
    expect(h.timers).toHaveLength(0);
  });

  it('hints that land while a read is in flight coalesce into one follow-up read', async () => {
    const h = harness();
    h.f.setLive(true); // the first read is still outstanding: queues instead of a second request
    h.f.hint(); h.f.hint(); h.f.hint();
    expect(h.pending).toHaveLength(1);
    await h.answer({ status: 'running' });
    expect(h.pending).toHaveLength(1); // exactly one queued read
    await h.answer({ status: 'done' });
    expect(h.pending).toHaveLength(0);
    expect(h.updates).toHaveLength(2);
  });

  it('coalesceMs: hints inside the window become one read', async () => {
    const h = harness({ coalesceMs: 100, live: true, livePollMs: 0 });
    await h.answer({ status: 'a' });
    h.f.hint(); h.f.hint(); h.f.hint();
    expect(h.pending).toHaveLength(0);
    expect(h.timers).toHaveLength(1);
    expect(await h.tick()).toBe(100);
    expect(h.pending).toHaveLength(1);
    await h.answer({ status: 'b' });
    expect(h.timers).toHaveLength(0);
    expect(h.updates.map((u) => u.status)).toEqual(['a', 'b']);
  });

  it('isHint filters frames passed to hint(frame); hint() without a frame always counts', async () => {
    const h = harness({ live: true, isHint: (f) => (f as { type?: string }).type === 'changed' });
    await h.answer({ status: 'a' });
    expect(h.f.hint({ type: 'other' })).toBe(false);
    expect(h.pending).toHaveLength(0);
    expect(h.f.hint({ type: 'changed' })).toBe(true);
    expect(h.pending).toHaveLength(1);
    await h.answer({ status: 'b' });
    expect(h.f.hint()).toBe(true);
    expect(h.pending).toHaveLength(1);
  });

  it('a reconnect re-reads (frames sent while down are only in the record)', async () => {
    const h = harness({ pollMs: 100 });
    await h.answer({ status: 'queued' });
    h.f.setLive(true); await h.answer({ status: 'running' });
    h.f.setLive(false); // dropped: back to the offline cadence now
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.at).toBe(100);
    h.f.setLive(true); // reconnected before the poll fired
    expect(h.pending).toHaveLength(1);
    expect(h.timers).toHaveLength(0);
    await h.answer({ status: 'done' });
    expect(h.updates.at(-1)).toEqual({ status: 'done' });
  });

  it('hidden pauses the poll; visible reads at once when one came due, else resumes the rest', async () => {
    const h = harness({ pollMs: 1000 });
    await h.answer({ status: 'a' });
    h.f.setHidden(true);
    expect(h.timers).toHaveLength(0); // paused
    h.advance(400);
    h.f.setHidden(false); // not due yet: the remaining 600
    expect(h.timers[0]!.at).toBe(1000);
    h.f.setHidden(true);
    h.advance(5000);
    expect(h.pending).toHaveLength(0);
    h.f.setHidden(false); // overdue: read now
    expect(h.pending).toHaveLength(1);
  });

  it('starting hidden waits for visible; a hint still reads while hidden', async () => {
    const h = harness({ pollMs: 1000, hidden: true, live: true, livePollMs: 1000 });
    await h.answer({ status: 'a' });
    expect(h.timers).toHaveLength(0);
    h.f.hint();
    expect(h.pending).toHaveLength(1);
  });

  it('immediate: false waits for the first poll', async () => {
    const h = harness({ pollMs: 100, immediate: false });
    expect(h.pending).toHaveLength(0);
    expect(await h.tick()).toBe(100);
    expect(h.pending).toHaveLength(1);
  });

  it('refresh() skips the coalescing window', async () => {
    const h = harness({ coalesceMs: 500, live: true, livePollMs: 0 });
    await h.answer({ status: 'a' });
    h.f.hint();
    h.f.refresh();
    expect(h.pending).toHaveLength(1);
    expect(h.timers).toHaveLength(0); // the pending coalesce is covered by this read
  });

  it('a read that throws synchronously counts as a failure', async () => {
    const errors: unknown[] = [];
    const timers: unknown[] = [];
    const f = createLiveRefresh({
      read: () => { throw new Error('sync'); },
      onError: (e) => errors.push(e),
      hidden: false,
      timers: { setTimeout: (fn, ms) => { timers.push(ms); return 1; }, clearTimeout: () => undefined },
      pollMs: 10,
    });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(errors).toHaveLength(1);
    expect(timers).toEqual([20]);
    f.dispose();
  });

  it('dispose aborts the read in flight, leaves no timers, and nothing reports after it', async () => {
    const h = harness({ pollMs: 100, coalesceMs: 50, live: true });
    await h.answer({ status: 'a' });
    h.f.hint();             // coalesce timer
    expect(h.timers.length).toBeGreaterThan(0);
    await h.tick();         // the read
    h.f.hint();             // another coalesce timer, behind an in-flight read
    h.f.dispose();
    expect(h.timers).toHaveLength(0);
    expect(h.pending[0]!.signal.aborted).toBe(true);
    await h.answer({ status: 'late' });
    expect(h.updates).toEqual([{ status: 'a' }]);
    h.f.hint(); h.f.refresh(); h.f.setLive(false); h.f.setHidden(true); h.f.setHidden(false);
    expect(h.timers).toHaveLength(0);
    expect(h.pending).toHaveLength(0);
    h.f.dispose(); // idempotent
  });
});
