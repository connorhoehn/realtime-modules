// realtime-modules/src/client/useAwarenessState.ts
//
// Lifted verbatim from frontend/src/hooks/useAwarenessState.ts.
// Single source of truth for ALL awareness state writes.
// Prevents the "overwrite" bug where independent writers (TiptapEditor,
// DocumentEditorPage, useCollaborativeDoc) would clobber each other's
// fields by calling setLocalStateField('user', partialObj).
//
// Every update MERGES with the existing state — never overwrites.

import { useRef, useState, useCallback, useEffect } from 'react';
import type { GatewayProvider } from './GatewayProvider';
import { useIdleDetector } from './useIdleDetector';

// Page hidden for less than this is treated as transient (DevTools, Alt-Tab,
// system dialog) — only after a sustained hidden window do we flip idle=true.
const HIDDEN_TO_IDLE_HOLDOFF_MS = 4000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AwarenessFields {
  userId: string;
  displayName: string;
  color: string;
  mode: string;
  currentSectionId: string | null;
  lastSeen: number;
  idle: boolean;
  /** Tiptap cursor display name (may differ from displayName in edge cases). */
  name?: string;
}

export interface AwarenessUpdaters {
  updateSection: (sectionId: string | null) => void;
  updateMode: (mode: string) => void;
  updateIdle: (idle: boolean) => void;
  /** Merge Tiptap-specific cursor info (name, color) without clobbering other fields. */
  updateCursorInfo: (name: string, color: string) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAwarenessState(
  provider: GatewayProvider | null,
  initial: Omit<AwarenessFields, 'lastSeen' | 'idle'>,
): AwarenessUpdaters {
  // Keep a mutable ref of the full awareness state so every updater
  // always merges against the latest snapshot — no stale closures.
  const stateRef = useRef<AwarenessFields>({
    ...initial,
    name: initial.displayName,
    lastSeen: Date.now(),
    idle: false,
  });

  // Ref to track provider so callbacks don't go stale
  const providerRef = useRef(provider);
  providerRef.current = provider;

  // ---- Flush helper: write the merged state to awareness --------------------
  const flush = useCallback(() => {
    const p = providerRef.current;
    if (!p?.awareness) return;
    stateRef.current.lastSeen = Date.now();
    p.awareness.setLocalStateField('user', { ...stateRef.current });
  }, []);

  // ---- Set initial state when provider becomes available --------------------
  useEffect(() => {
    if (!provider?.awareness) return;
    // Re-apply initial fields (provider may have changed on reconnect)
    stateRef.current = {
      ...stateRef.current,
      ...initial,
      name: initial.displayName,
      lastSeen: Date.now(),
    };
    flush();
  }, [provider, initial.userId, initial.displayName, initial.color, initial.mode, flush]);

  // ---- Idle detection — auto-broadcast idle changes -------------------------
  // Two sources are OR'd together:
  //   1. useIdleDetector — activity-timeout based (default 2min of no input)
  //   2. document visibility — page hidden for HIDDEN_TO_IDLE_HOLDOFF_MS
  //
  // The hold-off on hidden→idle prevents spurious idle flips from transient
  // focus loss (DevTools open, Alt-Tab, system dialog). visible→active is
  // immediate. The visible→active flip also cancels any pending hold-off.
  const { isIdle: detectorIdle } = useIdleDetector();
  const visibilityIdleRef = useRef(false);

  // Force re-render when visibility-derived idle flips, so the OR effect below
  // runs and writes the new combined state. State is the trigger; the ref is
  // the source of truth read by the effect (avoids stale closures).
  const [visibilityTick, setVisibilityTick] = useState(0);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    let holdoffTimer: ReturnType<typeof setTimeout> | null = null;

    const onVisibilityChange = () => {
      if (document.hidden) {
        if (holdoffTimer) clearTimeout(holdoffTimer);
        holdoffTimer = setTimeout(() => {
          holdoffTimer = null;
          if (!visibilityIdleRef.current) {
            visibilityIdleRef.current = true;
            setVisibilityTick((t) => t + 1);
          }
        }, HIDDEN_TO_IDLE_HOLDOFF_MS);
      } else {
        if (holdoffTimer) {
          clearTimeout(holdoffTimer);
          holdoffTimer = null;
        }
        if (visibilityIdleRef.current) {
          visibilityIdleRef.current = false;
          setVisibilityTick((t) => t + 1);
        }
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (holdoffTimer) clearTimeout(holdoffTimer);
    };
  }, []);

  useEffect(() => {
    const combined = detectorIdle || visibilityIdleRef.current;
    stateRef.current.idle = combined;
    flush();
  }, [detectorIdle, visibilityTick, flush]);

  // ---- Updaters (stable references via useCallback) -------------------------

  const updateSection = useCallback((sectionId: string | null) => {
    stateRef.current.currentSectionId = sectionId;
    flush();
  }, [flush]);

  const updateMode = useCallback((mode: string) => {
    stateRef.current.mode = mode;
    flush();
  }, [flush]);

  const updateIdle = useCallback((idle: boolean) => {
    stateRef.current.idle = idle;
    flush();
  }, [flush]);

  const updateCursorInfo = useCallback((name: string, color: string) => {
    stateRef.current.name = name;
    stateRef.current.color = color;
    flush();
  }, [flush]);

  return { updateSection, updateMode, updateIdle, updateCursorInfo };
}
