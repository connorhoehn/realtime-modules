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

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acquireChannelSubscription,
  cancelDraftRun,
  currentRunDraft,
  dispatchRunDraft,
  docWorkChannel,
  docWorkSignalFromFrame,
  docWorkSubscribeFrame,
  fetchRunDraft,
  fetchRunDrafts,
  newWorkItemId,
  putRunDraft,
  runDraftPhase,
} from './work';
import type { DocumentWorkRequestError, RunDraft, RunDraftInput, RunDraftPhase } from './work';
import { useRefreshOnReconnect, useResolvedTransport } from './transport';
import type { DocumentsLiveOptions } from './transport';

export interface UseRunDraftOptions extends DocumentsLiveOptions {
  documentGrant?: string | null;
}

export interface UseRunDraftResult {
  /** The draft the pane shows (newest not cancelled); `null` = "No draft". */
  draft: RunDraft | null;
  /** `runDraftPhase(draft)`: none · draft · dispatching · unconfirmed (> 60 s) · dispatched · cancelled. */
  phase: RunDraftPhase;
  /** The id the next `save` / `dispatch` uses — the draft's, or the one minted for the next draft. */
  draftId: string;
  loading: boolean;
  error?: string;
  /** Upsert the draft. Retrying the same input replays; a changed input carries `expectedRevision`. */
  save: (input: RunDraftInput) => Promise<RunDraft>;
  /** Dispatch the saved draft. Concurrent calls share one request. */
  dispatch: () => Promise<RunDraft>;
  /** Cancel the dispatched run through the existing cancel route. */
  stop: (reason?: string) => Promise<void>;
  /** 'save' | 'dispatch' | 'stop' while one is in flight. */
  busy: 'save' | 'dispatch' | 'stop' | null;
  /** Set by a 409 on save (the draft changed elsewhere) or dispatch (refused / in progress). */
  conflict: string | null;
  refresh: () => void;
  /**
   * Start a fresh draft: `draft` becomes `null` (phase `none`) and `draftId` a
   * newly minted requestId, so the next `save` creates a second draft instead
   * of hitting the dispatched one. The draft that was showing moves to
   * `history` and stays readable there (its signals keep it current); list
   * re-reads never bring it — or anything older — back as the current draft.
   * Refused while a dispatch is in flight. Returns the new `draftId`.
   */
  startNew: () => string;
  /** Drafts set aside by `startNew`, newest first, kept up to date. Empty until then. */
  history: RunDraft[];
}

export function useRunDraft(documentId: string | null | undefined, opts: UseRunDraftOptions): UseRunDraftResult {
  const { apiBaseUrl, idToken, documentGrant } = opts;
  const enabled = opts.enabled !== false && !!documentId && !!idToken;
  const { send, onMessage, epoch } = useResolvedTransport(opts.transport, opts.sessionEpoch);

  const [draft, setDraft] = useState<RunDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<UseRunDraftResult['busy']>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [history, setHistory] = useState<RunDraft[]>([]);
  // Drafts `startNew` set aside, and the newest server `updatedAt` among them:
  // a list read only offers drafts newer than that as the current one.
  const retired = useRef<Map<string, RunDraft>>(new Map());
  const retiredUntil = useRef<string>('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const draftRef = useRef<RunDraft | null>(null);
  const docRef = useRef(documentId);
  docRef.current = documentId;
  const nextIdRef = useRef<string>(newWorkItemId());
  const dispatching = useRef<Promise<RunDraft> | null>(null);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const publishHistory = useCallback(() => {
    setHistory([...retired.current.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)));
  }, []);

  /** A newer copy of a set-aside draft updates `history`; true when `d` was one. */
  const acceptRetired = useCallback((d: RunDraft): boolean => {
    const prev = retired.current.get(d.draftId);
    if (!prev) return false;
    if (d.revision >= prev.revision) { retired.current.set(d.draftId, d); publishHistory(); }
    return true;
  }, [publishHistory]);

  const accept = useCallback((d: RunDraft | null) => {
    if (d && d.documentId !== docRef.current) return;
    if (d && acceptRetired(d)) return;
    const cur = draftRef.current;
    if (d && cur && cur.draftId === d.draftId && d.revision < cur.revision) return;
    // A replaced draft means the minted id was used: mint the next one.
    if (d && d.draftId === nextIdRef.current) nextIdRef.current = newWorkItemId();
    draftRef.current = d;
    setDraft(d);
  }, [acceptRetired]);

  useEffect(() => {
    draftRef.current = null;
    setDraft(null);
    retired.current = new Map();
    retiredUntil.current = '';
    setHistory([]);
    setConflict(null);
    setError(undefined);
    nextIdRef.current = newWorkItemId();
    dispatching.current = null;
  }, [documentId]);

  useEffect(() => {
    if (!enabled || !documentId) { setLoading(false); return; }
    const controller = new AbortController();
    if (!draftRef.current) setLoading(true);
    fetchRunDrafts(apiBaseUrl, idToken, documentId, { signal: controller.signal })
      .then((drafts) => {
        if (!alive.current || controller.signal.aborted) return;
        // Set-aside drafts refresh `history`; the current one is chosen from
        // what came after them (startNew).
        const fresh = drafts.filter((d) => !acceptRetired(d) && (!retiredUntil.current || d.updatedAt > retiredUntil.current));
        const cur = currentRunDraft(fresh);
        draftRef.current = null; // the list read is authoritative
        accept(cur);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!alive.current || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (alive.current && !controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, apiBaseUrl, idToken, documentId, tick, accept, acceptRetired]);

  useEffect(() => {
    if (!enabled || !documentId || !send || !onMessage || !idToken) return;
    const release = acquireChannelSubscription(
      send,
      docWorkChannel(documentId),
      docWorkSubscribeFrame('subscribe', { documentId }, documentGrant),
      docWorkSubscribeFrame('unsubscribe', { documentId }),
      epoch,
    );
    const unregister = onMessage((frame: unknown) => {
      const signal = docWorkSignalFromFrame(frame);
      if (!signal || signal.type !== 'doc:run_draft_updated' || signal.documentId !== documentId) return;
      const cur = draftRef.current;
      if (cur && cur.draftId === signal.draftId && signal.revision > 0 && signal.revision <= cur.revision) return;
      const old = retired.current.get(signal.draftId);
      if (old && signal.revision > 0 && signal.revision <= old.revision) return;
      // A draft other than the one shown (and not one set aside): the list
      // decides which is current. `startNew` leaves nothing shown, so any
      // other draft goes through the list too.
      if (!old && (cur ? cur.draftId !== signal.draftId : retired.current.size > 0)) { refresh(); return; }
      fetchRunDraft(apiBaseUrl, idToken, documentId, signal.draftId)
        .then((d) => { if (alive.current) accept(d); })
        .catch(() => { /* the next signal or reconnect re-reads it */ });
    });
    return () => { unregister(); release(); };
  }, [enabled, documentId, documentGrant, send, onMessage, epoch, apiBaseUrl, idToken, accept, refresh]);

  useRefreshOnReconnect(epoch, refresh);

  const currentId = (): string => {
    const cur = draftRef.current;
    return cur && (cur.status === 'draft' || cur.status === 'dispatching') ? cur.draftId : nextIdRef.current;
  };

  const save = useCallback(async (input: RunDraftInput): Promise<RunDraft> => {
    const id = docRef.current;
    if (!id || !idToken) throw new Error('No document to draft a run for');
    const draftId = currentId();
    const cur = draftRef.current;
    setBusy('save');
    try {
      const saved = await putRunDraft(apiBaseUrl, idToken, id, draftId, {
        ...input,
        ...(cur && cur.draftId === draftId ? { expectedRevision: cur.revision } : {}),
      });
      if (alive.current) { accept(saved); setConflict(null); }
      return saved;
    } catch (err) {
      if (alive.current && (err as DocumentWorkRequestError).status === 409) {
        setConflict((err as Error).message);
        refresh();
      }
      throw err;
    } finally {
      if (alive.current) setBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, idToken, accept, refresh]);

  const dispatch = useCallback((): Promise<RunDraft> => {
    if (dispatching.current) return dispatching.current;
    const id = docRef.current;
    const cur = draftRef.current;
    if (!id || !idToken) return Promise.reject(new Error('No document to dispatch for'));
    if (!cur || (cur.status !== 'draft' && cur.status !== 'dispatching')) {
      return Promise.reject(new Error('Save the draft before dispatching it'));
    }
    setBusy('dispatch');
    const p = dispatchRunDraft(apiBaseUrl, idToken, id, cur.draftId)
      .then((d) => { if (alive.current) { accept(d); setConflict(null); } return d; })
      .catch((err: unknown) => {
        if (alive.current && (err as DocumentWorkRequestError).status === 409) {
          setConflict((err as Error).message);
          refresh();
        }
        throw err;
      })
      .finally(() => {
        dispatching.current = null;
        if (alive.current) setBusy(null);
      });
    dispatching.current = p;
    return p;
  }, [apiBaseUrl, idToken, accept, refresh]);

  const stop = useCallback(async (reason?: string): Promise<void> => {
    const cur = draftRef.current;
    if (!idToken) throw new Error('Not signed in');
    if (!cur?.runId) throw new Error('No run to stop');
    setBusy('stop');
    try {
      await cancelDraftRun(apiBaseUrl, idToken, cur.runId, reason);
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [apiBaseUrl, idToken]);

  const startNew = useCallback((): string => {
    if (dispatching.current) throw new Error('A dispatch is in flight; wait for it before starting a new draft');
    const cur = draftRef.current;
    if (cur) {
      retired.current.set(cur.draftId, cur);
      if (cur.updatedAt > retiredUntil.current) retiredUntil.current = cur.updatedAt;
      publishHistory();
    }
    if (!cur || cur.draftId === nextIdRef.current) nextIdRef.current = newWorkItemId();
    draftRef.current = null;
    setDraft(null);
    setConflict(null);
    return nextIdRef.current;
  }, [publishHistory]);

  return {
    draft,
    phase: runDraftPhase(draft),
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
