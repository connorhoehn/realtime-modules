// realtime-modules/src/client/documents/useLinkedDocumentWork.ts
//
// The work rows of the documents another item links to (the Brief tab's
// "Dependencies & decisions" chips). Each linked row is read over REST behind
// the viewer's own token, and kept current by the same id-only
// `doc:work_updated` signal `useDocumentWork` rides, on `doc-work:<linkedId>`.
//
// ACCESS: a linked document the viewer may not read answers the REST read
// 403/404. That id is reported in `restricted` and is never subscribed, so the
// viewer learns nothing about it — not its title (the host must not draw one)
// and not its status. The gateway's `doc-work` service applies the document
// read rule to every subscription too; subscribing only after a successful
// read keeps a refused subscribe from ever being sent.
//
// A signal re-reads only the document it names. A newer signal wins over an
// in-flight read (the read is aborted and re-issued). Reconnect re-reads all.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  acquireChannelSubscription,
  docWorkChannel,
  docWorkSignalFromFrame,
  docWorkSubscribeFrame,
  fetchDocumentWork,
} from './work';
import type { DocumentWork, DocumentWorkRequestError } from './work';
import { useRefreshOnReconnect, useResolvedTransport } from './transport';
import type { DocumentsLiveOptions } from './transport';

export interface LinkedDocumentWorkResult {
  /** Each readable linked document's row, by id. Absent until its first read lands. */
  work: Readonly<Record<string, DocumentWork>>;
  /** Linked ids the viewer may not read (the read answered 403 or 404). */
  restricted: ReadonlySet<string>;
  /** Re-read every linked row. */
  refresh: () => void;
}

const isRestricted = (err: unknown) => {
  const status = (err as DocumentWorkRequestError | undefined)?.status;
  return status === 403 || status === 404;
};

export function useLinkedDocumentWork(documentIds: readonly string[], opts: DocumentsLiveOptions): LinkedDocumentWorkResult {
  const { apiBaseUrl, idToken } = opts;
  const enabled = opts.enabled !== false && !!idToken;
  const { send, onMessage, epoch } = useResolvedTransport(opts.transport, opts.sessionEpoch);

  // A stable key: the same set in any order is the same set.
  const key = useMemo(() => Array.from(new Set(documentIds.filter(Boolean))).sort().join('\n'), [documentIds]);
  const ids = useMemo(() => (key ? key.split('\n') : []), [key]);

  const [work, setWork] = useState<Record<string, DocumentWork>>({});
  const [restricted, setRestricted] = useState<ReadonlySet<string>>(() => new Set());
  const inflight = useRef(new Map<string, AbortController>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const read = useCallback((id: string) => {
    if (!idToken) return;
    inflight.current.get(id)?.abort();
    const controller = new AbortController();
    inflight.current.set(id, controller);
    fetchDocumentWork(apiBaseUrl, idToken, id, { signal: controller.signal })
      .then((row) => {
        if (!alive.current || controller.signal.aborted) return;
        setWork((w) => (w[id] && w[id].revision > row.revision ? w : { ...w, [id]: row }));
        setRestricted((r) => { if (!r.has(id)) return r; const n = new Set(r); n.delete(id); return n; });
      })
      .catch((err: unknown) => {
        if (!alive.current || controller.signal.aborted) return;
        if (!isRestricted(err)) return; // a transient failure keeps what we had
        setWork((w) => { if (!(id in w)) return w; const n = { ...w }; delete n[id]; return n; });
        setRestricted((r) => (r.has(id) ? r : new Set(r).add(id)));
      })
      .finally(() => { if (inflight.current.get(id) === controller) inflight.current.delete(id); });
  }, [apiBaseUrl, idToken]);

  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Read every linked row when the set (or identity) changes; drop rows no longer linked.
  useEffect(() => {
    if (!enabled) { setWork({}); setRestricted(new Set()); return; }
    const keep = new Set(ids);
    setWork((w) => Object.fromEntries(Object.entries(w).filter(([id]) => keep.has(id))));
    setRestricted((r) => new Set([...r].filter((id) => keep.has(id))));
    for (const id of ids) read(id);
    const flights = inflight.current;
    return () => { for (const c of flights.values()) c.abort(); flights.clear(); };
  }, [enabled, ids, read, tick]);

  // Live: one refcounted `doc-work:<id>` subscription per READABLE linked row.
  const readable = useMemo(() => ids.filter((id) => id in work).join('\n'), [ids, work]);
  useEffect(() => {
    if (!enabled || !readable || !send || !onMessage) return;
    const live = new Set(readable.split('\n'));
    const releases = [...live].map((id) => acquireChannelSubscription(
      send,
      docWorkChannel(id),
      docWorkSubscribeFrame('subscribe', { documentId: id }),
      docWorkSubscribeFrame('unsubscribe', { documentId: id }),
      epoch,
    ));
    const unregister = onMessage((frame: unknown) => {
      const signal = docWorkSignalFromFrame(frame);
      if (!signal || signal.type !== 'doc:work_updated' || !live.has(signal.documentId)) return;
      read(signal.documentId);
    });
    return () => { unregister(); for (const r of releases) r(); };
  }, [enabled, readable, send, onMessage, epoch, read]);

  useRefreshOnReconnect(epoch, refresh);

  return { work, restricted, refresh };
}
