"use strict";
// useLVSRecordings — read-only hook that lists recordings for a given
// channel ARN. Thin wrapper around the LVS `GET /api/channels/:arn/recordings`
// endpoint with auto-fetch on mount + refetch helper.
//
// Pure data-layer — does NOT touch the DOM, does NOT mint playback
// tokens (that's `useLVSHlsPlayer`'s job). Designed to compose with
// list-view shells like `<RecordingList>` from ui-components.
//
// Recording shape mirrors the LVS-side record persisted by
// RecordingManager._persistRecord, with optional fields for fields
// platform-api decorates downstream (callId, lobbyName, etc.).
Object.defineProperty(exports, "__esModule", { value: true });
exports.useLVSRecordings = useLVSRecordings;
const react_1 = require("react");
const LVSProvider_1 = require("./LVSProvider");
function useLVSRecordings(opts) {
    const ctx = (0, LVSProvider_1.useSafeLVSContext)();
    const baseUrl = opts.baseUrl ?? ctx?.baseUrl ?? '';
    const [recordings, setRecordings] = (0, react_1.useState)([]);
    const [isLoading, setIsLoading] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    // Tick counter to force-refetch via refetch().
    const [tick, setTick] = (0, react_1.useState)(0);
    const refetch = (0, react_1.useCallback)(() => setTick(t => t + 1), []);
    const abortRef = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(() => {
        if (!opts.channelArn || !baseUrl) {
            setRecordings([]);
            return;
        }
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        setIsLoading(true);
        setError(null);
        const headers = {};
        if (opts.authToken)
            headers.Authorization = `Bearer ${opts.authToken}`;
        fetch(`${baseUrl}/api/channels/${encodeURIComponent(opts.channelArn)}/recordings`, { headers, signal: ac.signal })
            .then(async (res) => {
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const data = (await res.json());
            const list = Array.isArray(data) ? data : (data?.recordings ?? []);
            if (!ac.signal.aborted)
                setRecordings(list);
        })
            .catch((e) => {
            if (ac.signal.aborted)
                return;
            setError(e?.message ?? String(e));
        })
            .finally(() => {
            if (!ac.signal.aborted)
                setIsLoading(false);
        });
        return () => ac.abort();
    }, [opts.channelArn, baseUrl, opts.authToken, tick]);
    return (0, react_1.useMemo)(() => ({ recordings, isLoading, error, refetch }), [recordings, isLoading, error, refetch]);
}
//# sourceMappingURL=useLVSRecordings.js.map