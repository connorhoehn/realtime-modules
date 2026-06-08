/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useAwarenessState.test.tsx
//
// Lifted from frontend/src/hooks/__tests__/useAwarenessState.test.ts.
// Vitest → Jest conversion (vi.* → jest.*).

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
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

  describe('visibility-derived idle', () => {
    let originalHidden: PropertyDescriptor | undefined;
    let hiddenValue = false;

    beforeEach(() => {
      // Stub document.hidden so we can flip it from tests.
      originalHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
      hiddenValue = false;
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => hiddenValue,
      });
    });

    afterEach(() => {
      if (originalHidden) {
        Object.defineProperty(Document.prototype, 'hidden', originalHidden);
      } else {
        // jsdom default: `hidden` lives on the instance prototype as a real
        // getter — restore by deleting our override.
        delete (document as unknown as { hidden?: boolean }).hidden;
      }
    });

    function dispatchVisibility() {
      document.dispatchEvent(new Event('visibilitychange'));
    }

    it('holds off for 4000ms before flipping idle=true when page becomes hidden', () => {
      const { provider, latest } = makeFakeProvider();
      renderHook(() => useAwarenessState(provider, INITIAL));

      // Sanity: initial state has idle=false.
      expect(latest().idle).toBe(false);

      act(() => {
        hiddenValue = true;
        dispatchVisibility();
      });

      // Still false 100ms in — within the hold-off window.
      act(() => { jest.advanceTimersByTime(100); });
      expect(latest().idle).toBe(false);

      // Still false 3999ms in.
      act(() => { jest.advanceTimersByTime(3899); });
      expect(latest().idle).toBe(false);

      // Past 4000ms total — idle should now be true.
      act(() => { jest.advanceTimersByTime(2); });
      expect(latest().idle).toBe(true);
    });

    it('cancels the hold-off if page becomes visible again before 4000ms', () => {
      const { provider, latest } = makeFakeProvider();
      renderHook(() => useAwarenessState(provider, INITIAL));

      act(() => {
        hiddenValue = true;
        dispatchVisibility();
      });

      // 2 seconds in — within hold-off, idle still false.
      act(() => { jest.advanceTimersByTime(2000); });
      expect(latest().idle).toBe(false);

      // Page becomes visible — cancels the pending hold-off.
      act(() => {
        hiddenValue = false;
        dispatchVisibility();
      });

      // Advance past the original 4000ms window — idle must still be false.
      act(() => { jest.advanceTimersByTime(5000); });
      expect(latest().idle).toBe(false);
    });

    it('flips idle=false immediately on visible→active transition (no hold-off)', () => {
      const { provider, latest } = makeFakeProvider();
      renderHook(() => useAwarenessState(provider, INITIAL));

      // Get into idle=true via sustained hidden.
      act(() => {
        hiddenValue = true;
        dispatchVisibility();
      });
      act(() => { jest.advanceTimersByTime(4100); });
      expect(latest().idle).toBe(true);

      // Page visible again — idle should clear in the very next flush, no timer.
      act(() => {
        hiddenValue = false;
        dispatchVisibility();
      });
      expect(latest().idle).toBe(false);
    });
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
