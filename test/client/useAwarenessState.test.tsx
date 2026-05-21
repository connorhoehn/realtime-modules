/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useAwarenessState.test.tsx
//
// Lifted from frontend/src/hooks/__tests__/useAwarenessState.test.ts.
// Vitest → Jest conversion (vi.* → jest.*).

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { renderHook, act } from '@testing-library/react';
import { useAwarenessState } from '../../src/client/useAwarenessState';

// Minimal fake awareness — records the merged `user` field on every write so
// tests can assert the merge preserves prior fields (the whole point of this
// hook — see its file header for the "overwrite bug" it prevents).
function makeFakeProvider() {
  const stateLog: Array<Record<string, unknown>> = [];
  const awareness = {
    setLocalStateField: jest.fn((key: unknown, value: unknown) => {
      if (key === 'user') stateLog.push({ ...(value as Record<string, unknown>) });
    }),
  };
  return {
    provider: { awareness } as unknown as Parameters<typeof useAwarenessState>[0],
    awareness,
    stateLog,
    latest: () => stateLog[stateLog.length - 1],
  };
}

const INITIAL = {
  userId: 'hank-001',
  displayName: 'Hank Anderson',
  color: '#14b8a6',
  mode: 'editor',
  currentSectionId: null,
};

describe('useAwarenessState', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  it('no-ops when provider is null (no throws)', () => {
    const { result } = renderHook(() => useAwarenessState(null, INITIAL));
    // Calling an updater without a provider must not throw.
    expect(() => {
      act(() => result.current.updateSection('section-1'));
      act(() => result.current.updateMode('ack'));
      act(() => result.current.updateIdle(true));
    }).not.toThrow();
  });

  it('writes initial state to awareness when provider becomes available', () => {
    const { provider, latest, awareness } = makeFakeProvider();
    renderHook(() => useAwarenessState(provider, INITIAL));
    expect(awareness.setLocalStateField).toHaveBeenCalled();
    const state = latest();
    expect(state.userId).toBe('hank-001');
    expect(state.displayName).toBe('Hank Anderson');
    expect(state.color).toBe('#14b8a6');
    expect(state.mode).toBe('editor');
    // Tiptap alias for cursor rendering
    expect(state.name).toBe('Hank Anderson');
  });

  it('updateSection only replaces currentSectionId; other fields persist', () => {
    const { provider, latest } = makeFakeProvider();
    const { result } = renderHook(() => useAwarenessState(provider, INITIAL));

    act(() => result.current.updateSection('section-42'));

    const state = latest();
    expect(state.currentSectionId).toBe('section-42');
    // Other fields must not be clobbered (the whole point of this hook)
    expect(state.userId).toBe('hank-001');
    expect(state.displayName).toBe('Hank Anderson');
    expect(state.color).toBe('#14b8a6');
    expect(state.mode).toBe('editor');
  });

  it('updateMode only replaces mode', () => {
    const { provider, latest } = makeFakeProvider();
    const { result } = renderHook(() => useAwarenessState(provider, INITIAL));

    act(() => result.current.updateMode('ack'));

    const state = latest();
    expect(state.mode).toBe('ack');
    expect(state.userId).toBe('hank-001');
    expect(state.color).toBe('#14b8a6');
  });

  it('updateCursorInfo only replaces name + color; other fields persist', () => {
    const { provider, latest } = makeFakeProvider();
    const { result } = renderHook(() => useAwarenessState(provider, INITIAL));

    act(() => result.current.updateCursorInfo('Hank A.', '#ff0000'));

    const state = latest();
    expect(state.name).toBe('Hank A.');
    expect(state.color).toBe('#ff0000');
    // userId, mode, currentSectionId untouched
    expect(state.userId).toBe('hank-001');
    expect(state.mode).toBe('editor');
    expect(state.currentSectionId).toBeNull();
  });

  it('multiple updaters compose without overwriting each other', () => {
    const { provider, latest } = makeFakeProvider();
    const { result } = renderHook(() => useAwarenessState(provider, INITIAL));

    act(() => result.current.updateSection('section-5'));
    act(() => result.current.updateMode('reader'));
    act(() => result.current.updateCursorInfo('Hank', '#00ff00'));

    const state = latest();
    expect(state.currentSectionId).toBe('section-5');
    expect(state.mode).toBe('reader');
    expect(state.name).toBe('Hank');
    expect(state.color).toBe('#00ff00');
    // Original userId and displayName still present
    expect(state.userId).toBe('hank-001');
    expect(state.displayName).toBe('Hank Anderson');
  });

  it('updates lastSeen timestamp on every flush', () => {
    const { provider, stateLog } = makeFakeProvider();
    const { result } = renderHook(() => useAwarenessState(provider, INITIAL));

    const firstSeen = stateLog[0].lastSeen as number;
    expect(typeof firstSeen).toBe('number');

    // Advance time then trigger a flush
    act(() => { jest.advanceTimersByTime(500); });
    act(() => result.current.updateMode('ack'));

    const lastSeen = stateLog[stateLog.length - 1].lastSeen as number;
    expect(lastSeen).toBeGreaterThan(firstSeen);
  });

  it('exposes a stable return object across renders (updaters have referential stability)', () => {
    const { provider } = makeFakeProvider();
    const { result, rerender } = renderHook(
      ({ p, init }) => useAwarenessState(p, init),
      { initialProps: { p: provider, init: INITIAL } },
    );

    const firstUpdaters = result.current;
    rerender({ p: provider, init: INITIAL });
    const secondUpdaters = result.current;

    expect(secondUpdaters.updateSection).toBe(firstUpdaters.updateSection);
    expect(secondUpdaters.updateMode).toBe(firstUpdaters.updateMode);
    expect(secondUpdaters.updateCursorInfo).toBe(firstUpdaters.updateCursorInfo);
  });
});
