"use strict";
// realtime-modules/src/client/documents/useDocumentWork.ts
//
// One document's work fields (§2.1): read over REST, edited with optimistic
// PATCHes, kept current by the gateway's id-only `doc:work_updated` signal on
// `doc-work:<documentId>` (the hook re-reads the record — the frame carries no
// text) and by one re-read per reconnect. No polling.
//
// Edits queue: each PATCH carries the last CONFIRMED revision, and the view is
// the confirmed row with every queued edit applied on top. A failed edit drops
// out of the queue, so the view rolls back to confirmed + the rest. A 409 also
// re-reads the row and reports `conflict` with the fields the server named.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useDocumentWork = useDocumentWork;
const react_1 = require("react");
const work_1 = require("./work");
const transport_1 = require("./transport");
function useDocumentWork(documentId, opts) {
    const { apiBaseUrl, idToken, documentGrant } = opts;
    const enabled = opts.enabled !== false && !!documentId && !!idToken;
    const { send, onMessage, epoch } = (0, transport_1.useResolvedTransport)(opts.transport, opts.sessionEpoch);
    const [confirmed, setConfirmed] = (0, react_1.useState)(null);
    const [queue, setQueue] = (0, react_1.useState)([]);
    const [loading, setLoading] = (0, react_1.useState)(true);
    const [error, setError] = (0, react_1.useState)(undefined);
    const [conflict, setConflict] = (0, react_1.useState)(null);
    const [tick, setTick] = (0, react_1.useState)(0);
    const alive = (0, react_1.useRef)(true);
    (0, react_1.useEffect)(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const confirmedRef = (0, react_1.useRef)(null);
    const docRef = (0, react_1.useRef)(documentId);
    docRef.current = documentId;
    const chain = (0, react_1.useRef)(Promise.resolve());
    const nextId = (0, react_1.useRef)(0);
    const accept = (0, react_1.useCallback)((work) => {
        if (work.documentId && work.documentId !== docRef.current)
            return;
        const cur = confirmedRef.current;
        // Never step backwards: an in-flight read can land after a newer PATCH answer.
        if (cur && cur.documentId === work.documentId && work.revision < cur.revision)
            return;
        confirmedRef.current = work;
        setConfirmed(work);
    }, []);
    const refresh = (0, react_1.useCallback)(() => setTick((t) => t + 1), []);
    // A different document is a different row.
    (0, react_1.useEffect)(() => {
        confirmedRef.current = null;
        setConfirmed(null);
        setQueue([]);
        setConflict(null);
        setError(undefined);
    }, [documentId]);
    (0, react_1.useEffect)(() => {
        if (!enabled || !documentId) {
            setLoading(false);
            return;
        }
        const controller = new AbortController();
        if (!confirmedRef.current)
            setLoading(true);
        (0, work_1.fetchDocumentWork)(apiBaseUrl, idToken, documentId, { signal: controller.signal })
            .then((work) => { if (alive.current && !controller.signal.aborted) {
            accept(work);
            setError(undefined);
        } })
            .catch((err) => {
            if (!alive.current || controller.signal.aborted)
                return;
            setError(err instanceof Error ? err.message : String(err));
        })
            .finally(() => { if (alive.current && !controller.signal.aborted)
            setLoading(false); });
        return () => controller.abort();
    }, [enabled, apiBaseUrl, idToken, documentId, tick, accept]);
    // Live: `doc-work:<documentId>`, refcounted with the other hooks on this socket.
    (0, react_1.useEffect)(() => {
        if (!enabled || !documentId || !send || !onMessage)
            return;
        const release = (0, work_1.acquireChannelSubscription)(send, (0, work_1.docWorkChannel)(documentId), (0, work_1.docWorkSubscribeFrame)('subscribe', { documentId }, documentGrant), (0, work_1.docWorkSubscribeFrame)('unsubscribe', { documentId }), epoch);
        const unregister = onMessage((frame) => {
            const signal = (0, work_1.docWorkSignalFromFrame)(frame);
            if (!signal || signal.type !== 'doc:work_updated' || signal.documentId !== documentId)
                return;
            const cur = confirmedRef.current;
            if (cur && signal.revision > 0 && signal.revision <= cur.revision)
                return;
            refresh();
        });
        return () => { unregister(); release(); };
    }, [enabled, documentId, documentGrant, send, onMessage, epoch, refresh]);
    (0, transport_1.useRefreshOnReconnect)(epoch, refresh);
    const update = (0, react_1.useCallback)((edit) => {
        const id = documentId;
        if (!id || !idToken)
            return Promise.reject(new Error('No document to update'));
        const entry = { id: nextId.current++, update: edit };
        setQueue((q) => [...q, entry]);
        const drop = () => { if (alive.current)
            setQueue((q) => q.filter((e) => e.id !== entry.id)); };
        const run = chain.current.catch(() => undefined).then(async () => {
            const base = confirmedRef.current;
            try {
                const saved = await (0, work_1.patchDocumentWork)(apiBaseUrl, idToken, id, { expectedRevision: base?.revision ?? 0, ...edit });
                if (alive.current) {
                    accept(saved);
                    setConflict(null);
                }
                return saved;
            }
            catch (err) {
                const e = err;
                if (alive.current && e.status === 409) {
                    const named = e.body && Array.isArray(e.body.fields) ? e.body.fields.filter((x) => typeof x === 'string') : [];
                    setConflict({ fields: named, message: e.message });
                    refresh();
                }
                throw err;
            }
            finally {
                drop();
            }
        });
        chain.current = run;
        return run;
    }, [apiBaseUrl, idToken, documentId, accept, refresh]);
    const work = (0, react_1.useMemo)(() => (confirmed ? queue.reduce((w, e) => (0, work_1.applyWorkUpdate)(w, e.update), confirmed) : null), [confirmed, queue]);
    const clearConflict = (0, react_1.useCallback)(() => setConflict(null), []);
    return {
        work,
        tracked: confirmed?.tracked === true,
        loading,
        ...(error ? { error } : {}),
        update,
        pending: queue.length,
        conflict,
        clearConflict,
        refresh,
    };
}
//# sourceMappingURL=useDocumentWork.js.map