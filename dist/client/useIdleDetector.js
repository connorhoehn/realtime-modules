"use strict";
// realtime-modules/src/client/useIdleDetector.ts
//
// Lifted verbatim from frontend/src/hooks/useIdleDetector.ts — required
// dependency of useAwarenessState. Tracks user activity (mouse, keyboard,
// touch, click) and reports idle state after a configurable timeout
// (default 2 minutes). Debounces activity events to avoid firing on every
// mousemove.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useIdleDetector = useIdleDetector;
const react_1 = require("react");
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const DEBOUNCE_MS = 500; // debounce activity events
function useIdleDetector(options = {}) {
    const { timeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = options;
    const [isIdle, setIsIdle] = (0, react_1.useState)(false);
    const idleTimerRef = (0, react_1.useRef)(null);
    const debounceRef = (0, react_1.useRef)(null);
    const isIdleRef = (0, react_1.useRef)(false);
    const resetIdleTimer = (0, react_1.useCallback)(() => {
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
    const handleActivity = (0, react_1.useCallback)(() => {
        // Debounce: ignore rapid-fire events
        if (debounceRef.current !== null)
            return;
        debounceRef.current = setTimeout(() => {
            debounceRef.current = null;
        }, DEBOUNCE_MS);
        resetIdleTimer();
    }, [resetIdleTimer]);
    (0, react_1.useEffect)(() => {
        const events = [
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
//# sourceMappingURL=useIdleDetector.js.map