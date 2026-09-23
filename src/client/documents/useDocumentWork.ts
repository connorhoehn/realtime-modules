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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  acquireChannelSubscription,
  applyWorkUpdate,
  docWorkChannel,
  docWorkSignalFromFrame,
  docWorkSubscribeFrame,
  fetchDocumentWork,
  patchDocumentWork,
} from './work';
import type { DocumentWork, DocumentWorkRequestError, WorkUpdate } from './work';
import { useRefreshOnReconnect, useResolvedTransport } from './transport';
import type { DocumentsLiveOptions } from './transport';

export interface UseDocumentWorkOptions extends DocumentsLiveOptions {
  /** A per-document grant for the gateway's read check, when the host holds one. */
  documentGrant?: string | null;
}

export interface DocumentWorkConflict {
  /** The fields the server said moved on (from the 409 body), when it named them. */
  fields: string[];
  message: string;
}

export interface UseDocumentWorkResult {
  /** The row with queued edits applied; `null` until the first read. */
  work: DocumentWork | null;
  /** False while the platform has nothing stored (the row is a read-time backfill). */
  tracked: boolean;
  loading: boolean;
  error?: string;
  /** Apply an edit now and PATCH it. Resolves with the saved row; rejects (after rollback) on failure. */
  update: (update: WorkUpdate) => Promise<DocumentWork>;
  /** Edits sent or queued and not yet confirmed. */
  pending: number;
  /** Set by a 409 until the next successful edit or `clearConflict()`. */
  conflict: DocumentWorkConflict | null;
  clearConflict: () => void;
  refresh: () => void;
}

interface Queued { id: number; update: WorkUpdate }

export function useDocumentWork(documentId: string | null | undefined, opts: UseDocumentWorkOptions): UseDocumentWorkResult {
  const { apiBaseUrl, idToken, documentGrant } = opts;
  const enabled = opts.enabled !== false && !!documentId && !!idToken;
  const { send, onMessage, epoch } = useResolvedTransport(opts.transport, opts.sessionEpoch);

  const [confirmed, setConfirmed] = useState<DocumentWork | null>(null);
  const [queue, setQueue] = useState<readonly Queued[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState<DocumentWorkConflict | null>(null);
  const [tick, setTick] = useState(0);

  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const confirmedRef = useRef<DocumentWork | null>(null);
  const docRef = useRef(documentId);
  docRef.current = documentId;
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const nextId = useRef(0);

  const accept = useCallback((work: DocumentWork) => {
    if (work.documentId && work.documentId !== docRef.current) return;
    const cur = confirmedRef.current;
    // Never step backwards: an in-flight read can land after a newer PATCH answer.
    if (cur && cur.documentId === work.documentId && work.revision < cur.revision) return;
    confirmedRef.current = work;
    setConfirmed(work);
  }, []);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // A different document is a different row.
  useEffect(() => {
    confirmedRef.current = null;
    setConfirmed(null);
    setQueue([]);
    setConflict(null);
    setError(undefined);
  }, [documentId]);

  useEffect(() => {
    if (!enabled || !documentId) { setLoading(false); return; }
    const controller = new AbortController();
    if (!confirmedRef.current) setLoading(true);
    fetchDocumentWork(apiBaseUrl, idToken, documentId, { signal: controller.signal })
      .then((work) => { if (alive.current && !controller.signal.aborted) { accept(work); setError(undefined); } })
      .catch((err: unknown) => {
        if (!alive.current || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (alive.current && !controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, apiBaseUrl, idToken, documentId, tick, accept]);

  // Live: `doc-work:<documentId>`, refcounted with the other hooks on this socket.
  useEffect(() => {
    if (!enabled || !documentId || !send || !onMessage) return;
    const release = acquireChannelSubscription(
      send,
      docWorkChannel(documentId),
      docWorkSubscribeFrame('subscribe', { documentId }, documentGrant),
      docWorkSubscribeFrame('unsubscribe', { documentId }),
      epoch,
    );
    const unregister = onMessage((frame: unknown) => {
      const signal = docWorkSignalFromFrame(frame);
      if (!signal || signal.type !== 'doc:work_updated' || signal.documentId !== documentId) return;
      const cur = confirmedRef.current;
      if (cur && signal.revision > 0 && signal.revision <= cur.revision) return;
      refresh();
    });
    return () => { unregister(); release(); };
  }, [enabled, documentId, documentGrant, send, onMessage, epoch, refresh]);

  useRefreshOnReconnect(epoch, refresh);

  const update = useCallback((edit: WorkUpdate): Promise<DocumentWork> => {
    const id = documentId;
    if (!id || !idToken) return Promise.reject(new Error('No document to update'));
    const entry: Queued = { id: nextId.current++, update: edit };
    setQueue((q) => [...q, entry]);
    const drop = () => { if (alive.current) setQueue((q) => q.filter((e) => e.id !== entry.id)); };
    const run = chain.current.catch(() => undefined).then(async () => {
      const base = confirmedRef.current;
      try {
        const saved = await patchDocumentWork(apiBaseUrl, idToken, id, { expectedRevision: base?.revision ?? 0, ...edit });
        if (alive.current) { accept(saved); setConflict(null); }
        return saved;
      } catch (err) {
        const e = err as DocumentWorkRequestError;
        if (alive.current && e.status === 409) {
          const named = e.body && Array.isArray(e.body.fields) ? (e.body.fields as unknown[]).filter((x): x is string => typeof x === 'string') : [];
          setConflict({ fields: named, message: e.message });
          refresh();
        }
        throw err;
      } finally {
        drop();
      }
    });
    chain.current = run;
    return run;
  }, [apiBaseUrl, idToken, documentId, accept, refresh]);

  const work = useMemo(
    () => (confirmed ? queue.reduce((w, e) => applyWorkUpdate(w, e.update), confirmed) : null),
    [confirmed, queue],
  );
  const clearConflict = useCallback(() => setConflict(null), []);

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
