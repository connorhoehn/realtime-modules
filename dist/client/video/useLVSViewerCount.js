"use strict";
// How many people are watching.
//
// The one number a broadcast is actually about. A stream to a mass audience
// with no audience figure is a video call with extra steps: the person
// presenting cannot tell whether ten people or none are on the other side, and
// a viewer cannot tell whether they have joined something live or are alone in
// an empty room.
//
// LVS tracks it (`GET /api/channels/:arn/viewers` → `{concurrent_viewers}`) and
// nothing in the stack was asking. StreamStage has taken a `viewerCount` prop
// the entire time and no caller ever supplied one.
//
// Polled rather than pushed: the count is a soft number that is interesting at
// human resolution, and a WebSocket per viewer purely to animate a counter
// would cost more than the thing it reports.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useLVSViewerCount = useLVSViewerCount;
const react_1 = require("react");
const LVSProvider_1 = require("./LVSProvider");
function useLVSViewerCount({ channelArn, intervalMs = 15_000, baseUrl: baseUrlOpt, playbackToken, }) {
    const ctx = (0, LVSProvider_1.useSafeLVSContext)();
    const baseUrl = baseUrlOpt ?? ctx?.baseUrl ?? '';
    const [viewerCount, setViewerCount] = (0, react_1.useState)(null);
    const [error, setError] = (0, react_1.useState)(null);
    const tokenRef = (0, react_1.useRef)(playbackToken);
    tokenRef.current = playbackToken;
    (0, react_1.useEffect)(() => {
        // A channel that changed must not keep showing the previous one's audience.
        setViewerCount(null);
        setError(null);
        if (!channelArn || !baseUrl)
            return;
        let cancelled = false;
        const url = `${baseUrl.replace(/\/$/, '')}/api/channels/${encodeURIComponent(channelArn)}/viewers`;
        const poll = async () => {
            try {
                const res = await fetch(url, {
                    headers: tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : undefined,
                });
                if (cancelled)
                    return;
                if (!res.ok) {
                    // 503 means LVS has no viewer tracker configured. That is "unknown",
                    // not "zero" — leave the count null so the UI stays quiet rather
                    // than reporting an empty house.
                    setViewerCount(null);
                    return;
                }
                const body = (await res.json());
                if (cancelled)
                    return;
                setViewerCount(typeof body.concurrent_viewers === 'number' ? body.concurrent_viewers : null);
                setError(null);
            }
            catch (err) {
                if (cancelled)
                    return;
                setViewerCount(null);
                setError(err instanceof Error ? err : new Error(String(err)));
            }
        };
        void poll();
        const timer = setInterval(() => { void poll(); }, Math.max(2000, intervalMs));
        return () => { cancelled = true; clearInterval(timer); };
    }, [channelArn, baseUrl, intervalMs]);
    return { viewerCount, error };
}
//# sourceMappingURL=useLVSViewerCount.js.map