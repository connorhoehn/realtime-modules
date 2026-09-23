"use strict";
// realtime-modules/src/client/documents/useRunEstimate.ts
//
// The Run draft pane's cost and duration range (§2.3):
// `GET /api/pipelines/:pipelineId/estimate?model=`. `estimate: null` means the
// pipeline has no completed runs — the pane says "No prior runs" and shows no
// number. Answers are cached per page (one read per pipeline + model) until a
// `pipeline.run.completed` frame for that pipeline arrives on `pipeline:all`,
// which drops the cached answers for that pipeline and re-reads. No polling.
Object.defineProperty(exports, "__esModule", { value: true });
exports.invalidateRunEstimates = invalidateRunEstimates;
exports.useRunEstimate = useRunEstimate;
const react_1 = require("react");
const work_1 = require("./work");
const catalog_1 = require("../pipelines/catalog");
const usePipelineCatalog_1 = require("../pipelines/usePipelineCatalog");
const transport_1 = require("./transport");
const cache = new Map();
const keyOf = (apiBaseUrl, pipelineId, model) => `${apiBaseUrl}|${pipelineId}|${model ?? ''}`;
/** Drop every cached estimate for a pipeline (all models). */
function invalidateRunEstimates(pipelineId) {
    if (!pipelineId) {
        cache.clear();
        return;
    }
    for (const key of Array.from(cache.keys()))
        if (key.split('|')[1] === pipelineId)
            cache.delete(key);
}
function useRunEstimate(pipelineId, model, opts) {
    const { apiBaseUrl, idToken } = opts;
    const enabled = opts.enabled !== false && !!pipelineId && !!idToken;
    const { send, onMessage, epoch } = (0, transport_1.useResolvedTransport)(opts.transport, opts.sessionEpoch);
    const [estimate, setEstimate] = (0, react_1.useState)(null);
    const [settled, setSettled] = (0, react_1.useState)(false);
    const [loading, setLoading] = (0, react_1.useState)(enabled);
    const [error, setError] = (0, react_1.useState)(undefined);
    const [tick, setTick] = (0, react_1.useState)(0);
    const alive = (0, react_1.useRef)(true);
    (0, react_1.useEffect)(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const refresh = (0, react_1.useCallback)(() => {
        if (pipelineId)
            invalidateRunEstimates(pipelineId);
        setTick((t) => t + 1);
    }, [pipelineId]);
    (0, react_1.useEffect)(() => {
        if (!enabled || !pipelineId) {
            setLoading(false);
            setEstimate(null);
            setSettled(false);
            return;
        }
        let cancelled = false;
        const key = keyOf(apiBaseUrl, pipelineId, model);
        let p = cache.get(key);
        if (!p) {
            p = (0, work_1.fetchRunEstimate)(apiBaseUrl, idToken, pipelineId, model);
            cache.set(key, p);
            // A failed read is not cached.
            p.catch(() => { if (cache.get(key) === p)
                cache.delete(key); });
        }
        setLoading(true);
        p.then((e) => {
            if (cancelled || !alive.current)
                return;
            setEstimate(e);
            setSettled(true);
            setError(undefined);
        }).catch((err) => {
            if (cancelled || !alive.current)
                return;
            setError(err instanceof Error ? err.message : String(err));
        }).finally(() => { if (!cancelled && alive.current)
            setLoading(false); });
        return () => { cancelled = true; };
    }, [enabled, apiBaseUrl, idToken, pipelineId, model, tick]);
    (0, react_1.useEffect)(() => {
        if (!enabled || !pipelineId || !send || !onMessage)
            return;
        const frames = (0, usePipelineCatalog_1.pipelineAllSubscribeFrames)();
        const release = (0, work_1.acquireChannelSubscription)(send, usePipelineCatalog_1.PIPELINE_ALL_CHANNEL, frames.subscribe, frames.unsubscribe, epoch);
        const unregister = onMessage((frame) => {
            const event = (0, catalog_1.runEventFromFrame)(frame);
            if (!event || event.pipelineId !== pipelineId || event.status !== 'completed')
                return;
            refresh();
        });
        return () => { unregister(); release(); };
    }, [enabled, pipelineId, send, onMessage, epoch, refresh]);
    return {
        estimate,
        noPriorRuns: settled && !error && estimate === null,
        loading,
        ...(error ? { error } : {}),
        refresh,
    };
}
//# sourceMappingURL=useRunEstimate.js.map