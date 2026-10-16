/**
 * @jest-environment jsdom
 */
import { describe, it, expect, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useFollowMeetingLobby, meetingOfLobby } from '../../../src/client/meeting';

const M = 'room:lounge';
const R1 = `${M}~breakout~r1`;
const R2 = `${M}~breakout~r2`;

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(initial: { active: string | null; current: string | null; debounceMs?: number; enabled?: boolean }) {
  const log: string[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const step = async (name: string) => { inflight++; maxInflight = Math.max(maxInflight, inflight); log.push(name); await Promise.resolve(); inflight--; };
  const leave = jest.fn(() => step('leave'));
  const join = jest.fn((lobby: string) => step(`join ${lobby}`));
  type P = { active: string | null; current: string | null; enabled?: boolean };
  const r = renderHook<ReturnType<typeof useFollowMeetingLobby>, P>(
    (p: P) =>
      useFollowMeetingLobby(p.active, { currentLobby: p.current, leave, join, debounceMs: initial.debounceMs ?? 0, enabled: p.enabled }),
    { initialProps: { active: initial.active, current: initial.current, enabled: initial.enabled } },
  );
  return { ...r, log, leave, join, maxInflight: () => maxInflight };
}

describe('useFollowMeetingLobby', () => {
  it('meetingOfLobby maps a breakout lobby to its meeting', () => {
    expect(meetingOfLobby(R1)).toBe(M);
    expect(meetingOfLobby(M)).toBe(M);
  });

  it('leaves then joins when the meeting sends you to a room, and back', async () => {
    const h = harness({ active: M, current: M });
    h.rerender({ active: R1, current: M });
    await waitFor(() => expect(h.log).toEqual(['leave', `join ${R1}`]));
    // Host catches up, then the rooms close.
    h.rerender({ active: R1, current: R1 });
    h.rerender({ active: M, current: R1 });
    await waitFor(() => expect(h.log).toEqual(['leave', `join ${R1}`, 'leave', `join ${M}`]));
    expect(h.result.current.moving).toBe(false);
  });

  it('does not move when not in a call, when disabled, or when already there', async () => {
    const a = harness({ active: R1, current: null });
    const b = harness({ active: R1, current: M, enabled: false });
    const c = harness({ active: M, current: M });
    await new Promise((r) => setTimeout(r, 20));
    expect([...a.log, ...b.log, ...c.log]).toEqual([]);
  });

  it('never pulls someone out of an unrelated call', async () => {
    const h = harness({ active: R1, current: 'dm:u-a:u-b' });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.log).toEqual([]);
  });

  it('a host whose currentLobby lags does not cause a second move', async () => {
    const h = harness({ active: M, current: M });
    h.rerender({ active: R1, current: M });
    await waitFor(() => expect(h.join).toHaveBeenCalledTimes(1));
    // Some unrelated re-render while currentLobby still says M.
    h.rerender({ active: R1, current: M });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.join).toHaveBeenCalledTimes(1);
  });

  it('debounces bursts: only the last target is joined', async () => {
    jest.useFakeTimers();
    try {
      const h = harness({ active: M, current: M, debounceMs: 300 });
      h.rerender({ active: R1, current: M });
      act(() => { jest.advanceTimersByTime(100); });
      h.rerender({ active: R2, current: M });
      await act(async () => { jest.advanceTimersByTime(300); });
      jest.useRealTimers();
      await waitFor(() => expect(h.log).toEqual(['leave', `join ${R2}`]));
    } finally {
      jest.useRealTimers();
    }
  });

  it('a target change during a slow move is honoured after it settles, never concurrently', async () => {
    const gate = deferred();
    const log: string[] = [];
    let inflight = 0;
    let max = 0;
    const leave = jest.fn(async () => { inflight++; max = Math.max(max, inflight); log.push('leave'); inflight--; });
    const join = jest.fn(async (lobby: string) => {
      inflight++; max = Math.max(max, inflight); log.push(`join ${lobby}`);
      if (lobby === R1) await gate.promise;
      inflight--;
    });
    const { rerender, result } = renderHook(
      (p: { active: string; current: string }) => useFollowMeetingLobby(p.active, { currentLobby: p.current, leave, join, debounceMs: 0 }),
      { initialProps: { active: M, current: M } },
    );
    rerender({ active: R1, current: M });
    await waitFor(() => expect(result.current.moving).toBe(true));
    expect(result.current.target).toBe(R1);
    rerender({ active: R2, current: M }); // reassigned mid-join
    await new Promise((r) => setTimeout(r, 10));
    expect(join).toHaveBeenCalledTimes(1);
    await act(async () => { gate.resolve(); });
    await waitFor(() => expect(log).toEqual(['leave', `join ${R1}`, 'leave', `join ${R2}`]));
    expect(max).toBe(1);
    await waitFor(() => expect(result.current.moving).toBe(false));
  });

  it('a failed join is reported and stops following until the target changes', async () => {
    const join = jest.fn(async (lobby: string) => { if (lobby === R1) throw new Error('lobby refused'); });
    const leave = jest.fn(async () => {});
    const { rerender, result } = renderHook(
      (p: { active: string; current: string }) => useFollowMeetingLobby(p.active, { currentLobby: p.current, leave, join, debounceMs: 0 }),
      { initialProps: { active: M, current: M } },
    );
    rerender({ active: R1, current: M });
    await waitFor(() => expect((result.current.error as Error)?.message).toBe('lobby refused'));
    expect(result.current.moving).toBe(false);
    rerender({ active: R1, current: M });
    await new Promise((r) => setTimeout(r, 20));
    expect(join).toHaveBeenCalledTimes(1);
    rerender({ active: R2, current: M });
    await waitFor(() => expect(join).toHaveBeenLastCalledWith(R2));
    expect(result.current.error).toBeNull();
  });
});
