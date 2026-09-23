"use strict";
// realtime-modules/src/client/documents/useRunDraft.ts
//
// The Run draft pane (§1.6, §2.2): the document's current run draft, saved
// with an idempotent PUT and dispatched with a POST that is safe to repeat.
//
// Idempotency: the draft id IS the request id. It is minted once per draft and
// kept — a resend after a timeout, a double-click on Save or Dispatch, or a
// retry after a replica crash all carry the same id, so the platform does the
// work once. A new id is minted only after the current draft has been
// dispatched or cancelled (the next Save starts the next draft).
//
// Live: `doc:run_draft_updated` on `doc-work:<documentId>` (id-only) makes the
// hook re-read that one draft; a reconnect re-reads the list once. A reload
// mid-run restores the state from the draft row.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useRunDraft = useRunDraft;
const react_1 = require("react");
const work_1 = require("./work");
const transport_1 = require("./transport");
function useRunDraft(documentId, opts) {
    const { apiBaseUrl, idToken, documentGrant } = opts;
    const enabled = opts.enabled !== false && !!documentId && !!idToken;
    const { send, onMessage, epoch } = (0, transport_1.useResolvedTransport)(opts.transport, opts.sessionEpoch);
    const [draft, setDraft] = (0, react_1.useState)(null);
    const [loading, setLoading] = (0, react_1.useState)(true);
    const [error, setError] = (0, react_1.useState)(undefined);
    const [busy, setBusy] = (0, react_1.useState)(null);
    const [conflict, setConflict] = (0, react_1.useState)(null);
    const [tick, setTick] = (0, react_1.useState)(0);
    const [history, setHistory] = (0, react_1.useState)([]);
    // Drafts `startNew` set aside, and the newest server `updatedAt` among them:
    // a list read only offers drafts newer than that as the current one.
    const retired = (0, react_1.useRef)(new Map());
    const retiredUntil = (0, react_1.useRef)('');
    const alive = (0, react_1.useRef)(true);
    (0, react_1.useEffect)(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const draftRef = (0, react_1.useRef)(null);
    const docRef = (0, react_1.useRef)(documentId);
    docRef.current = documentId;
    const nextIdRef = (0, react_1.useRef)((0, work_1.newWorkItemId)());
    const dispatching = (0, react_1.useRef)(null);
    const refresh = (0, react_1.useCallback)(() => setTick((t) => t + 1), []);
    const publishHistory = (0, react_1.useCallback)(() => {
        setHistory([...retired.current.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)));
    }, []);
    /** A newer copy of a set-aside draft updates `history`; true when `d` was one. */
    const acceptRetired = (0, react_1.useCallback)((d) => {
        const prev = retired.current.get(d.draftId);
        if (!prev)
            return false;
        if (d.revision >= prev.revision) {
            retired.current.set(d.draftId, d);
            publishHistory();
        }
        return true;
    }, [publishHistory]);
    const accept = (0, react_1.useCallback)((d) => {
        if (d && d.documentId !== docRef.current)
            return;
        if (d && acceptRetired(d))
            return;
        const cur = draftRef.current;
        if (d && cur && cur.draftId === d.draftId && d.revision < cur.revision)
            return;
        // A replaced draft means the minted id was used: mint the next one.
        if (d && d.draftId === nextIdRef.current)
            nextIdRef.current = (0, work_1.newWorkItemId)();
        draftRef.current = d;
        setDraft(d);
    }, [acceptRetired]);
    (0, react_1.useEffect)(() => {
        draftRef.current = null;
        setDraft(null);
        retired.current = new Map();
        retiredUntil.current = '';
        setHistory([]);
        setConflict(null);
        setError(undefined);
        nextIdRef.current = (0, work_1.newWorkItemId)();
        dispatching.current = null;
    }, [documentId]);
    (0, react_1.useEffect)(() => {
        if (!enabled || !documentId) {
            setLoading(false);
            return;
        }
        const controller = new AbortController();
        if (!draftRef.current)
            setLoading(true);
        (0, work_1.fetchRunDrafts)(apiBaseUrl, idToken, documentId, { signal: controller.signal })
            .then((drafts) => {
            if (!alive.current || controller.signal.aborted)
                return;
            // Set-aside drafts refresh `history`; the current one is chosen from
            // what came after them (startNew).
            const fresh = drafts.filter((d) => !acceptRetired(d) && (!retiredUntil.current || d.updatedAt > retiredUntil.current));
            const cur = (0, work_1.currentRunDraft)(fresh);
            draftRef.current = null; // the list read is authoritative
            accept(cur);
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
    }, [enabled, apiBaseUrl, idToken, documentId, tick, accept, acceptRetired]);
    (0, react_1.useEffect)(() => {
        if (!enabled || !documentId || !send || !onMessage || !idToken)
            return;
        const release = (0, work_1.acquireChannelSubscription)(send, (0, work_1.docWorkChannel)(documentId), (0, work_1.docWorkSubscribeFrame)('subscribe', { documentId }, documentGrant), (0, work_1.docWorkSubscribeFrame)('unsubscribe', { documentId }), epoch);
        const unregister = onMessage((frame) => {
            const signal = (0, work_1.docWorkSignalFromFrame)(frame);
            if (!signal || signal.type !== 'doc:run_draft_updated' || signal.documentId !== documentId)
                return;
            const cur = draftRef.current;
            if (cur && cur.draftId === signal.draftId && signal.revision > 0 && signal.revision <= cur.revision)
                return;
            const old = retired.current.get(signal.draftId);
            if (old && signal.revision > 0 && signal.revision <= old.revision)
                return;
            // A draft other than the one shown (and not one set aside): the list
            // decides which is current. `startNew` leaves nothing shown, so any
            // other draft goes through the list too.
            if (!old && (cur ? cur.draftId !== signal.draftId : retired.current.size > 0)) {
                refresh();
                return;
            }
            (0, work_1.fetchRunDraft)(apiBaseUrl, idToken, documentId, signal.draftId)
                .then((d) => { if (alive.current)
                accept(d); })
                .catch(() => { });
        });
        return () => { unregister(); release(); };
    }, [enabled, documentId, documentGrant, send, onMessage, epoch, apiBaseUrl, idToken, accept, refresh]);
    (0, transport_1.useRefreshOnReconnect)(epoch, refresh);
    const currentId = () => {
        const cur = draftRef.current;
        return cur && (cur.status === 'draft' || cur.status === 'dispatching') ? cur.draftId : nextIdRef.current;
    };
    const save = (0, react_1.useCallback)(async (input) => {
        const id = docRef.current;
        if (!id || !idToken)
            throw new Error('No document to draft a run for');
        const draftId = currentId();
        const cur = draftRef.current;
        setBusy('save');
        try {
            const saved = await (0, work_1.putRunDraft)(apiBaseUrl, idToken, id, draftId, {
                ...input,
                ...(cur && cur.draftId === draftId ? { expectedRevision: cur.revision } : {}),
            });
            if (alive.current) {
                accept(saved);
                setConflict(null);
            }
            return saved;
        }
        catch (err) {
            if (alive.current && err.status === 409) {
                setConflict(err.message);
                refresh();
            }
            throw err;
        }
        finally {
            if (alive.current)
                setBusy(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiBaseUrl, idToken, accept, refresh]);
    const dispatch = (0, react_1.useCallback)(() => {
        if (dispatching.current)
            return dispatching.current;
        const id = docRef.current;
        const cur = draftRef.current;
        if (!id || !idToken)
            return Promise.reject(new Error('No document to dispatch for'));
        if (!cur || (cur.status !== 'draft' && cur.status !== 'dispatching')) {
            return Promise.reject(new Error('Save the draft before dispatching it'));
        }
        setBusy('dispatch');
        const p = (0, work_1.dispatchRunDraft)(apiBaseUrl, idToken, id, cur.draftId)
            .then((d) => { if (alive.current) {
            accept(d);
            setConflict(null);
        } return d; })
            .catch((err) => {
            if (alive.current && err.status === 409) {
                setConflict(err.message);
                refresh();
            }
            throw err;
        })
            .finally(() => {
            dispatching.current = null;
            if (alive.current)
                setBusy(null);
        });
        dispatching.current = p;
        return p;
    }, [apiBaseUrl, idToken, accept, refresh]);
    const stop = (0, react_1.useCallback)(async (reason) => {
        const cur = draftRef.current;
        if (!idToken)
            throw new Error('Not signed in');
        if (!cur?.runId)
            throw new Error('No run to stop');
        setBusy('stop');
        try {
            await (0, work_1.cancelDraftRun)(apiBaseUrl, idToken, cur.runId, reason);
        }
        finally {
            if (alive.current)
                setBusy(null);
        }
    }, [apiBaseUrl, idToken]);
    const startNew = (0, react_1.useCallback)(() => {
        if (dispatching.current)
            throw new Error('A dispatch is in flight; wait for it before starting a new draft');
        const cur = draftRef.current;
        if (cur) {
            retired.current.set(cur.draftId, cur);
            if (cur.updatedAt > retiredUntil.current)
                retiredUntil.current = cur.updatedAt;
            publishHistory();
        }
        if (!cur || cur.draftId === nextIdRef.current)
            nextIdRef.current = (0, work_1.newWorkItemId)();
        draftRef.current = null;
        setDraft(null);
        setConflict(null);
        return nextIdRef.current;
    }, [publishHistory]);
    return {
        draft,
        phase: (0, work_1.runDraftPhase)(draft),
        draftId: currentId(),
        loading,
        ...(error ? { error } : {}),
        save,
        dispatch,
        stop,
        busy,
        conflict,
        refresh,
        startNew,
        history,
    };
}
//# sourceMappingURL=useRunDraft.js.map