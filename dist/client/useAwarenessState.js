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
    const { isIdle } = (0, useIdleDetector_1.useIdleDetector)();
    (0, react_1.useEffect)(() => {
        stateRef.current.idle = isIdle;
        flush();
    }, [isIdle, flush]);
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