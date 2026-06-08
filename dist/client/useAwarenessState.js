"use strict";
// realtime-modules/src/client/useAwarenessState.ts
//
// Lifted verbatim from frontend/src/hooks/useAwarenessState.ts.
// Single source of truth for ALL awareness state writes.
// Prevents the "overwrite" bug where independent writers (TiptapEditor,
// DocumentEditorPage, useCollaborativeDoc) would clobber each other's
// fields by calling setLocalStateField('user', partialObj).
//
// Every update MERGES with the existing state — never overwrites.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useAwarenessState = useAwarenessState;
const react_1 = require("react");
const useIdleDetector_1 = require("./useIdleDetector");
// Page hidden for less than this is treated as transient (DevTools, Alt-Tab,
// system dialog) — only after a sustained hidden window do we flip idle=true.
const HIDDEN_TO_IDLE_HOLDOFF_MS = 4000;
// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
function useAwarenessState(provider, initial) {
    // Keep a mutable ref of the full awareness state so every updater
    // always merges against the latest snapshot — no stale closures.
    const stateRef = (0, react_1.useRef)({
        ...initial,
        name: initial.displayName,
        lastSeen: Date.now(),
        idle: false,
    });
    // Ref to track provider so callbacks don't go stale
    const providerRef = (0, react_1.useRef)(provider);
    providerRef.current = provider;
    // ---- Flush helper: write the merged state to awareness --------------------
    const flush = (0, react_1.useCallback)(() => {
        const p = providerRef.current;
        if (!p?.awareness)
            return;
        stateRef.current.lastSeen = Date.now();
        p.awareness.setLocalStateField('user', { ...stateRef.current });
    }, []);
    // ---- Set initial state when provider becomes available --------------------
    (0, react_1.useEffect)(() => {
        if (!provider?.awareness)
            return;
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
    const { isIdle: detectorIdle } = (0, useIdleDetector_1.useIdleDetector)();
    const visibilityIdleRef = (0, react_1.useRef)(false);
    // Force re-render when visibility-derived idle flips, so the OR effect below
    // runs and writes the new combined state. State is the trigger; the ref is
    // the source of truth read by the effect (avoids stale closures).
    const [visibilityTick, setVisibilityTick] = (0, react_1.useState)(0);
    (0, react_1.useEffect)(() => {
        if (typeof document === 'undefined')
            return;
        let holdoffTimer = null;
        const onVisibilityChange = () => {
            if (document.hidden) {
                if (holdoffTimer)
                    clearTimeout(holdoffTimer);
                holdoffTimer = setTimeout(() => {
                    holdoffTimer = null;
                    if (!visibilityIdleRef.current) {
                        visibilityIdleRef.current = true;
                        setVisibilityTick((t) => t + 1);
                    }
                }, HIDDEN_TO_IDLE_HOLDOFF_MS);
            }
            else {
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
            if (holdoffTimer)
                clearTimeout(holdoffTimer);
        };
    }, []);
    (0, react_1.useEffect)(() => {
        const combined = detectorIdle || visibilityIdleRef.current;
        stateRef.current.idle = combined;
        flush();
    }, [detectorIdle, visibilityTick, flush]);
    // ---- Updaters (stable references via useCallback) -------------------------
    const updateSection = (0, react_1.useCallback)((sectionId) => {
        stateRef.current.currentSectionId = sectionId;
        flush();
    }, [flush]);
    const updateMode = (0, react_1.useCallback)((mode) => {
        stateRef.current.mode = mode;
        flush();
    }, [flush]);
    const updateIdle = (0, react_1.useCallback)((idle) => {
        stateRef.current.idle = idle;
        flush();
    }, [flush]);
    const updateCursorInfo = (0, react_1.useCallback)((name, color) => {
        stateRef.current.name = name;
        stateRef.current.color = color;
        flush();
    }, [flush]);
    return { updateSection, updateMode, updateIdle, updateCursorInfo };
}
//# sourceMappingURL=useAwarenessState.js.map