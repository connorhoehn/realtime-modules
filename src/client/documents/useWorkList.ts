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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  acquireChannelSubscription,
  docWorkScopeChannel,
  docWorkScopeChannelMatches,
  docWorkSignalFromFrame,
  docWorkSubscribeFrame,
  fetchDocumentWork,
  fetchWorkList,
  groupWorkRows,
  mergeWorkIntoRow,
  pointsRollup,
} from './work';
import type { WorkGroup, WorkListRow, WorkRollup } from './work';
import { runEventFromFrame } from '../pipelines/catalog';
import { PIPELINE_ALL_CHANNEL, pipelineAllSubscribeFrames } from '../pipelines/usePipelineCatalog';
import { useRefreshOnReconnect, useResolvedTransport } from './transport';
import type { DocumentsLiveOptions } from './transport';

export interface UseWorkListOptions extends DocumentsLiveOptions {
  /** A grant on the scope's parent document for the gateway's read check, when the host holds one. */
  documentGrant?: string | null;
}

export interface UseWorkListResult {
  rows: readonly WorkListRow[];
  /** The header numbers; points are recomputed from the rows after each live merge. */
  rollup: WorkRollup | null;
  /** Rows grouped in `WORK_GROUP_ORDER`; empty groups omitted unless `includeEmpty`. */
  groups: (opts?: { includeEmpty?: boolean }) => WorkGroup[];
  loading: boolean;
  error?: string;
  refresh: () => void;
}

export function useWorkList(scope: string | null | undefined, opts: UseWorkListOptions): UseWorkListResult {
  const { apiBaseUrl, idToken, documentGrant } = opts;
  const enabled = opts.enabled !== false && !!scope && !!idToken;
  const { send, onMessage, epoch } = useResolvedTransport(opts.transport, opts.sessionEpoch);

  const [rows, setRows] = useState<readonly WorkListRow[]>([]);
  const [serverRollup, setServerRollup] = useState<WorkRollup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => { setRows([]); setServerRollup(null); setError(undefined); }, [scope]);

  useEffect(() => {
    if (!enabled || !scope) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading((l) => l || rows.length === 0);
    fetchWorkList(apiBaseUrl, idToken, scope, { signal: controller.signal })
      .then((list) => {
        if (!alive.current || controller.signal.aborted) return;
        setRows(list.rows);
        setServerRollup(list.rollup);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!alive.current || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (alive.current && !controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
    // `rows` is read only to decide the first spinner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, apiBaseUrl, idToken, scope, tick]);

  // Re-read one record and merge it; the newest revision wins.
  const inFlight = useRef(new Map<string, number>());
  const rereadOne = useCallback((documentId: string, revision: number) => {
    const s = scopeRef.current;
    if (!s || !idToken) return;
    const seen = inFlight.current.get(documentId);
    if (seen !== undefined && seen >= revision) return;
    inFlight.current.set(documentId, revision);
    fetchDocumentWork(apiBaseUrl, idToken, documentId)
      .then((work) => {
        if (!alive.current || scopeRef.current !== s) return;
        setRows((prev) => {
          const i = prev.findIndex((r) => r.documentId === documentId);
          const cur = i >= 0 ? prev[i] : undefined;
          if (cur && cur.revision > work.revision) return prev;
          if (work.scopeId && work.scopeId !== s) return i >= 0 ? prev.filter((_, k) => k !== i) : prev;
          const merged = mergeWorkIntoRow(cur, work);
          return i >= 0 ? prev.map((r, k) => (k === i ? merged : r)) : [...prev, merged];
        });
      })
      .catch(() => { /* the next signal or reconnect re-reads it */ })
      .finally(() => { if (inFlight.current.get(documentId) === revision) inFlight.current.delete(documentId); });
  }, [apiBaseUrl, idToken]);

  // Live: the scope channel.
  useEffect(() => {
    if (!enabled || !scope || !send || !onMessage) return;
    const release = acquireChannelSubscription(
      send,
      docWorkScopeChannel(scope),
      docWorkSubscribeFrame('subscribe', { scopeId: scope }, documentGrant),
      docWorkSubscribeFrame('unsubscribe', { scopeId: scope }),
      epoch,
    );
    const unregister = onMessage((frame: unknown) => {
      const signal = docWorkSignalFromFrame(frame);
      if (!signal || signal.type !== 'doc:work_updated') return;
      // A type scope arrives org-qualified (`doc-work-scope:<org>:type:<t>`).
      const onScope = !!signal.channel && docWorkScopeChannelMatches(signal.channel, scope);
      if (signal.channel && !onScope) return;
      // A row we do not hold joins only on a frame that names this scope's
      // channel; an unlabelled frame (another hook's `doc-work:<id>`) never adds one.
      const known = rowsRef.current.some((r) => r.documentId === signal.documentId);
      if (!known && !onScope) return;
      setRows((prev) => {
        const i = prev.findIndex((r) => r.documentId === signal.documentId);
        if (i < 0) return prev;
        const cur = prev[i];
        if (signal.revision > 0 && signal.revision <= cur.revision) return prev;
        const moved: WorkListRow = { ...cur };
        if (signal.status !== undefined) { if (signal.status) moved.status = signal.status; else delete moved.status; }
        if (signal.rank !== undefined) { if (signal.rank) moved.rank = signal.rank; else delete moved.rank; }
        return prev.map((r, k) => (k === i ? moved : r));
      });
      rereadOne(signal.documentId, signal.revision);
    });
    return () => { unregister(); release(); };
  }, [enabled, scope, documentGrant, send, onMessage, epoch, rereadOne]);

  // Live: run status for rows with a dispatched run.
  useEffect(() => {
    if (!enabled || !send || !onMessage) return;
    const frames = pipelineAllSubscribeFrames();
    const release = acquireChannelSubscription(send, PIPELINE_ALL_CHANNEL, frames.subscribe, frames.unsubscribe, epoch);
    const unregister = onMessage((frame: unknown) => {
      const event = runEventFromFrame(frame);
      if (!event) return;
      setRows((prev) => {
        let changed = false;
        const next = prev.map((r) => {
          if (!r.activeRun || r.activeRun.runId !== event.runId || r.activeRun.status === event.status) return r;
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

  useRefreshOnReconnect(epoch, refresh);

  const rollup = useMemo<WorkRollup | null>(
    () => (serverRollup ? { ...serverRollup, ...pointsRollup(rows) } : null),
    [serverRollup, rows],
  );
  const groups = useCallback((o?: { includeEmpty?: boolean }) => groupWorkRows(rows, o), [rows]);

  return { rows, rollup, groups, loading, ...(error ? { error } : {}), refresh };
}
