// realtime-modules/src/client/documents/useRunEstimate.ts
//
// The Run draft pane's cost and duration range (§2.3):
// `GET /api/pipelines/:pipelineId/estimate?model=`. `estimate: null` means the
// pipeline has no completed runs — the pane says "No prior runs" and shows no
// number. Answers are cached per page (one read per pipeline + model) until a
// `pipeline.run.completed` frame for that pipeline arrives on `pipeline:all`,
// which drops the cached answers for that pipeline and re-reads. No polling.

import { useCallback, useEffect, useRef, useState } from 'react';
import { acquireChannelSubscription, fetchRunEstimate } from './work';
import type { RunEstimate } from './work';
import { runEventFromFrame } from '../pipelines/catalog';
import { PIPELINE_ALL_CHANNEL, pipelineAllSubscribeFrames } from '../pipelines/usePipelineCatalog';
import { useResolvedTransport } from './transport';
import type { DocumentsLiveOptions } from './transport';

export type UseRunEstimateOptions = DocumentsLiveOptions;

export interface UseRunEstimateResult {
  /** `null` = "No prior runs" (also `null` while loading — check `loading`). */
  estimate: RunEstimate | null;
  /** True once a read settled with no prior runs. */
  noPriorRuns: boolean;
  loading: boolean;
  error?: string;
  refresh: () => void;
}

const cache = new Map<string, Promise<RunEstimate | null>>();
const keyOf = (apiBaseUrl: string, pipelineId: string, model?: string | null) => `${apiBaseUrl}|${pipelineId}|${model ?? ''}`;

/** Drop every cached estimate for a pipeline (all models). */
export function invalidateRunEstimates(pipelineId?: string): void {
  if (!pipelineId) { cache.clear(); return; }
  for (const key of Array.from(cache.keys())) if (key.split('|')[1] === pipelineId) cache.delete(key);
}

export function useRunEstimate(
  pipelineId: string | null | undefined,
  model: string | null | undefined,
  opts: UseRunEstimateOptions,
): UseRunEstimateResult {
  const { apiBaseUrl, idToken } = opts;
  const enabled = opts.enabled !== false && !!pipelineId && !!idToken;
  const { send, onMessage, epoch } = useResolvedTransport(opts.transport, opts.sessionEpoch);

  const [estimate, setEstimate] = useState<RunEstimate | null>(null);
  const [settled, setSettled] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = useCallback(() => {
    if (pipelineId) invalidateRunEstimates(pipelineId);
    setTick((t) => t + 1);
  }, [pipelineId]);

  useEffect(() => {
    if (!enabled || !pipelineId) { setLoading(false); setEstimate(null); setSettled(false); return; }
    let cancelled = false;
    const key = keyOf(apiBaseUrl, pipelineId, model);
    let p = cache.get(key);
    if (!p) {
      p = fetchRunEstimate(apiBaseUrl, idToken, pipelineId, model);
      cache.set(key, p);
      // A failed read is not cached.
      p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
    }
    setLoading(true);
    p.then((e) => {
      if (cancelled || !alive.current) return;
      setEstimate(e);
      setSettled(true);
      setError(undefined);
    }).catch((err: unknown) => {
      if (cancelled || !alive.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }).finally(() => { if (!cancelled && alive.current) setLoading(false); });
    return () => { cancelled = true; };
  }, [enabled, apiBaseUrl, idToken, pipelineId, model, tick]);

  useEffect(() => {
    if (!enabled || !pipelineId || !send || !onMessage) return;
    const frames = pipelineAllSubscribeFrames();
    const release = acquireChannelSubscription(send, PIPELINE_ALL_CHANNEL, frames.subscribe, frames.unsubscribe, epoch);
    const unregister = onMessage((frame: unknown) => {
      const event = runEventFromFrame(frame);
      if (!event || event.pipelineId !== pipelineId || event.status !== 'completed') return;
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
