// realtime-modules/src/client/useIdleDetector.ts
//
// Lifted verbatim from frontend/src/hooks/useIdleDetector.ts — required
// dependency of useAwarenessState. Tracks user activity (mouse, keyboard,
// touch, click) and reports idle state after a configurable timeout
// (default 2 minutes). Debounces activity events to avoid firing on every
// mousemove.

import { useState, useEffect, useCallback, useRef } from 'react';

const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const DEBOUNCE_MS = 500; // debounce activity events

export interface UseIdleDetectorOptions {
  /** Idle timeout in milliseconds (default: 120000 = 2 minutes). */
  timeoutMs?: number;
}

export interface UseIdleDetectorReturn {
  isIdle: boolean;
}

export function useIdleDetector(
  options: UseIdleDetectorOptions = {},
): UseIdleDetectorReturn {
  const { timeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = options;

  const [isIdle, setIsIdle] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isIdleRef = useRef(false);

  const resetIdleTimer = useCallback(() => {
    // Clear existing idle timer
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
    }

    // If currently idle, mark active immediately
    if (isIdleRef.current) {
      isIdleRef.current = false;
      setIsIdle(false);
    }

    // Start new idle timer
    idleTimerRef.current = setTimeout(() => {
      isIdleRef.current = true;
      setIsIdle(true);
    }, timeoutMs);
  }, [timeoutMs]);

  const handleActivity = useCallback(() => {
    // Debounce: ignore rapid-fire events
    if (debounceRef.current !== null) return;

    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
    }, DEBOUNCE_MS);

    resetIdleTimer();
  }, [resetIdleTimer]);

  useEffect(() => {
    const events: (keyof WindowEventMap)[] = [
      'mousemove',
      'keydown',
      'click',
      'touchstart',
      'scroll',
    ];

    for (const event of events) {
      window.addEventListener(event, handleActivity, { passive: true });
    }

    // Start the initial idle timer
    resetIdleTimer();

    return () => {
      for (const event of events) {
        window.removeEventListener(event, handleActivity);
      }
      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current);
      }
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [handleActivity, resetIdleTimer]);

  return { isIdle };
}
