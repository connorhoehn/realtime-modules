"use strict";
// realtime-modules/src/client/documents/useWorkList.ts
//
// The Work column (§1.4, §2.1): one read of `GET /api/document-work?scope=`,
// grouped by work status ("Not planned" for rows without one), kept current by
//   - `doc:work_updated` on `doc-work-scope:<scope>` — the id-only signal moves
//     the row's status/rank at once, then the hook re-reads that ONE record
//     (never the whole list) and merges it; a record that left the scope drops
//     out, a new one joins;
//   - the `pipeline:all` run frames — a row's live `activeRun` status follows
//     its run, sharing the subscription (refcounted) with `usePipelineCatalog`;
//   - one full re-read per reconnect. No polling.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useWorkList = useWorkList;
const react_1 = require("react");
const work_1 = require("./work");
const catalog_1 = require("../pipelines/catalog");
const usePipelineCatalog_1 = require("../pipelines/usePipelineCatalog");
const transport_1 = require("./transport");
function useWorkList(scope, opts) {
    const { apiBaseUrl, idToken, documentGrant } = opts;
    const enabled = opts.enabled !== false && !!scope && !!idToken;
    const { send, onMessage, epoch } = (0, transport_1.useResolvedTransport)(opts.transport, opts.sessionEpoch);
    const [rows, setRows] = (0, react_1.useState)([]);
    const [serverRollup, setServerRollup] = (0, react_1.useState)(null);
    const [loading, setLoading] = (0, react_1.useState)(true);
    const [error, setError] = (0, react_1.useState)(undefined);
    const [tick, setTick] = (0, react_1.useState)(0);
    const alive = (0, react_1.useRef)(true);
    (0, react_1.useEffect)(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const scopeRef = (0, react_1.useRef)(scope);
    scopeRef.current = scope;
    const refresh = (0, react_1.useCallback)(() => setTick((t) => t + 1), []);
    const rowsRef = (0, react_1.useRef)(rows);
    rowsRef.current = rows;
    (0, react_1.useEffect)(() => { setRows([]); setServerRollup(null); setError(undefined); }, [scope]);
    (0, react_1.useEffect)(() => {
        if (!enabled || !scope) {
            setLoading(false);
            return;
        }
        const controller = new AbortController();
        setLoading((l) => l || rows.length === 0);
        (0, work_1.fetchWorkList)(apiBaseUrl, idToken, scope, { signal: controller.signal })
            .then((list) => {
            if (!alive.current || controller.signal.aborted)
                return;
            setRows(list.rows);
            setServerRollup(list.rollup);
            setError(undefined);
        })
            .catch((err) => {
            if (!alive.current || controller.signal.aborted)
                return;
            setError(err instanceof Error ? err.message : String(err));
        })
            .finally(() => { if (alive.current && !controller.signal.aborted)
            setLoading(false); });
        return () => controller.abort();
        // `rows` is read only to decide the first spinner.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, apiBaseUrl, idToken, scope, tick]);
    // Re-read one record and merge it; the newest revision wins.
    const inFlight = (0, react_1.useRef)(new Map());
    const rereadOne = (0, react_1.useCallback)((documentId, revision) => {
        const s = scopeRef.current;
        if (!s || !idToken)
            return;
        const seen = inFlight.current.get(documentId);
        if (seen !== undefined && seen >= revision)
            return;
        inFlight.current.set(documentId, revision);
        (0, work_1.fetchDocumentWork)(apiBaseUrl, idToken, documentId)
            .then((work) => {
            if (!alive.current || scopeRef.current !== s)
                return;
            setRows((prev) => {
                const i = prev.findIndex((r) => r.documentId === documentId);
                const cur = i >= 0 ? prev[i] : undefined;
                if (cur && cur.revision > work.revision)
                    return prev;
                if (work.scopeId && work.scopeId !== s)
                    return i >= 0 ? prev.filter((_, k) => k !== i) : prev;
                const merged = (0, work_1.mergeWorkIntoRow)(cur, work);
                return i >= 0 ? prev.map((r, k) => (k === i ? merged : r)) : [...prev, merged];
            });
        })
            .catch(() => { })
            .finally(() => { if (inFlight.current.get(documentId) === revision)
            inFlight.current.delete(documentId); });
    }, [apiBaseUrl, idToken]);
    // Live: the scope channel.
    (0, react_1.useEffect)(() => {
        if (!enabled || !scope || !send || !onMessage)
            return;
        const release = (0, work_1.acquireChannelSubscription)(send, (0, work_1.docWorkScopeChannel)(scope), (0, work_1.docWorkSubscribeFrame)('subscribe', { scopeId: scope }, documentGrant), (0, work_1.docWorkSubscribeFrame)('unsubscribe', { scopeId: scope }), epoch);
        const channel = (0, work_1.docWorkScopeChannel)(scope);
        const unregister = onMessage((frame) => {
            const signal = (0, work_1.docWorkSignalFromFrame)(frame);
            if (!signal || signal.type !== 'doc:work_updated')
                return;
            if (signal.channel && signal.channel !== channel)
                return;
            // A row we do not hold joins only on a frame that names this scope's
            // channel; an unlabelled frame (another hook's `doc-work:<id>`) never adds one.
            const known = rowsRef.current.some((r) => r.documentId === signal.documentId);
            if (!known && signal.channel !== channel)
                return;
            setRows((prev) => {
                const i = prev.findIndex((r) => r.documentId === signal.documentId);
                if (i < 0)
                    return prev;
                const cur = prev[i];
                if (signal.revision > 0 && signal.revision <= cur.revision)
                    return prev;
                const moved = { ...cur };
                if (signal.status !== undefined) {
                    if (signal.status)
                        moved.status = signal.status;
                    else
                        delete moved.status;
                }
                if (signal.rank !== undefined) {
                    if (signal.rank)
                        moved.rank = signal.rank;
                    else
                        delete moved.rank;
                }
                return prev.map((r, k) => (k === i ? moved : r));
            });
            rereadOne(signal.documentId, signal.revision);
        });
        return () => { unregister(); release(); };
    }, [enabled, scope, documentGrant, send, onMessage, epoch, rereadOne]);
    // Live: run status for rows with a dispatched run.
    (0, react_1.useEffect)(() => {
        if (!enabled || !send || !onMessage)
            return;
        const frames = (0, usePipelineCatalog_1.pipelineAllSubscribeFrames)();
        const release = (0, work_1.acquireChannelSubscription)(send, usePipelineCatalog_1.PIPELINE_ALL_CHANNEL, frames.subscribe, frames.unsubscribe, epoch);
        const unregister = onMessage((frame) => {
            const event = (0, catalog_1.runEventFromFrame)(frame);
            if (!event)
                return;
            setRows((prev) => {
                let changed = false;
                const next = prev.map((r) => {
                    if (!r.activeRun || r.activeRun.runId !== event.runId || r.activeRun.status === event.status)
                        return r;
                    changed = true;
                    return {
                        ...r,
                        activeRun: {
                            ...r.activeRun,
                            status: event.status,
                            updatedAt: event.at,
                            ...(event.completedAt ? { completedAt: event.completedAt } : {}),
                        },
                    };
                });
                return changed ? next : prev;
            });
        });
        return () => { unregister(); release(); };
    }, [enabled, send, onMessage, epoch]);
    (0, transport_1.useRefreshOnReconnect)(epoch, refresh);
    const rollup = (0, react_1.useMemo)(() => (serverRollup ? { ...serverRollup, ...(0, work_1.pointsRollup)(rows) } : null), [serverRollup, rows]);
    const groups = (0, react_1.useCallback)((o) => (0, work_1.groupWorkRows)(rows, o), [rows]);
    return { rows, rollup, groups, loading, ...(error ? { error } : {}), refresh };
}
//# sourceMappingURL=useWorkList.js.map