// realtime-modules/src/client/useAwarenessState.ts
//
// Lifted verbatim from frontend/src/hooks/useAwarenessState.ts.
// Single source of truth for ALL awareness state writes.
// Prevents the "overwrite" bug where independent writers (TiptapEditor,
// DocumentEditorPage, useCollaborativeDoc) would clobber each other's
// fields by calling setLocalStateField('user', partialObj).
//
// Every update MERGES with the existing state — never overwrites.

import { useRef, useCallback, useEffect } from 'react';
import type { GatewayProvider } from './GatewayProvider';
import { useIdleDetector } from './useIdleDetector';

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
  const { isIdle } = useIdleDetector();

  useEffect(() => {
    stateRef.current.idle = isIdle;
    flush();
  }, [isIdle, flush]);

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
