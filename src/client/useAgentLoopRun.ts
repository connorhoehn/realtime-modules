// realtime-modules/src/client/useAgentLoopRun.ts
//
// One agent loop (platform-api `/api/agent-loops/:runId`), for a task card or
// a task strip: where it is, which step, how many steps are done, and the one
// control it really has — Stop.
//
// Two sources, like usePipelineRunStatus:
//   - Durable: `GET {apiBaseUrl}/api/agent-loops/:runId` on mount, again on
//     every live frame for the run (debounced), and every `pollMs` while the
//     loop is not over as a safety net for a missed frame.
//   - Live: the gateway's `pipeline:event` frames on
//     `pipeline:run:<executorRunId ?? runId>`. A frame is a nudge to re-read,
//     not a second source of truth — the view is the platform's.
//
// PAUSE: not offered. The platform says so in the view
// (`controls.pause === false`, `controls.pauseUnsupportedReason`) and answers
// `POST …/pause|resume` with 501. The result carries `canPause: false` and the
// reason so a UI can explain the missing button instead of rendering one that
// does nothing. When the platform grows real pause, this hook grows
// `pause()`/`resume()` behind `controls.pause`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGatewayOptional } from './GatewaySocketProvider';
import type { GatewayMessage } from './types';
import type { PipelineRunTransport } from './pipelines/usePipelineRunStatus';

export type AgentLoopRunPhase = 'planning' | 'running' | 'completed' | 'failed' | 'cancelled' | 'budget' | 'unknown';

export interface AgentLoopRunStep {
  id: string;
  nodeId?: string;
  title: string;
  kind?: string;
  status: string;
  iterations?: number;
  contextTokens?: number;
  error?: string;
  skipped?: boolean;
}

export interface AgentLoopRunControls {
  stop: boolean;
  pause: boolean;
  resume: boolean;
  pauseUnsupportedReason?: string;
}

/** The platform's AgentLoopView, as far as this hook reads it. Other fields pass through. */
export interface AgentLoopRunView {
  runId: string;
  pipelineId?: string;
  status: string;
  label?: string;
  startedAt?: string;
  elapsedMs?: number;
  model?: string;
  contextBudgetTokens?: number;
  contextTokens?: number;
  iterations?: number;
  steps: AgentLoopRunStep[];
  error?: string;
  executorRunId?: string;
  controls?: AgentLoopRunControls;
  [key: string]: unknown;
}

export interface UseAgentLoopRunOptions {
  /** platform-api origin, e.g. `http://localhost:13001`. */
  apiBaseUrl: string;
  /** Bearer for the reads and Stop; `null` disables both. */
  idToken: string | null;
  /** A host-owned socket. Omit to use the nearest GatewaySocketProvider; `null` disables live frames. */
  transport?: PipelineRunTransport | null;
  /** Safety-net re-read interval while the loop is not over. Default 5000; 0 disables. */
  pollMs?: number;
  /** Debounce between a live frame and the re-read it causes. Default 250. */
  frameDebounceMs?: number;
}

export interface AgentLoopStopResult { ok: boolean; status?: number; error?: string }

export interface UseAgentLoopRunResult {
  loop?: AgentLoopRunView;
  /** True until the first read answers. */
  loading: boolean;
  /** The platform answered 404: no such loop, or not one this person may see. */
  notFound: boolean;
  /** The last read's failure, when it failed for another reason. */
  error?: string;
  phase: AgentLoopRunPhase;
  status?: string;
  steps: AgentLoopRunStep[];
  /** The step running now, else the next pending one. */
  currentStep?: AgentLoopRunStep;
  stepsDone: number;
  stepsTotal: number;
  /** stepsDone / stepsTotal as 0–100, only when the plan has steps. A count of steps, not a time estimate. */
  percent?: number;
  startedAt?: string;
  /** The platform says Stop will do something (the loop is not over). */
  canStop: boolean;
  stopping: boolean;
  stop: () => Promise<AgentLoopStopResult>;
  /** Always false today — see `pauseUnsupportedReason`. */
  canPause: false;
  pauseUnsupportedReason: string;
  refresh: () => void;
}

export const DEFAULT_AGENT_LOOP_POLL_MS = 5_000;
export const PAUSE_UNSUPPORTED_FALLBACK = 'Pausing is not supported: a running step cannot be suspended. Stop ends the run.';

const DONE_STEP = new Set(['completed', 'succeeded', 'failed', 'skipped', 'cancelled', 'canceled']);

/** The platform's status word, folded into the phases a strip renders. */
export function agentLoopPhase(status: string | undefined): AgentLoopRunPhase {
  switch (status) {
    case 'planning':
    case 'pending': return 'planning';
    case 'running':
    case 'in_progress':
    case 'awaiting_approval':
    case 'paused_at_breakpoint': return 'running';
    case 'completed':
    case 'succeeded': return 'completed';
    case 'failed':
    case 'rejected': return 'failed';
    case 'cancelled':
    case 'canceled': return 'cancelled';
    case 'budget': return 'budget';
    default: return 'unknown';
  }
}

export function isAgentLoopOver(phase: AgentLoopRunPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled' || phase === 'budget';
}

/** Steps done / total and the step in hand. Pure. */
export function agentLoopProgress(steps: readonly AgentLoopRunStep[]): { stepsDone: number; stepsTotal: number; percent?: number; currentStep?: AgentLoopRunStep } {
  const stepsTotal = steps.length;
  const stepsDone = steps.filter((step) => DONE_STEP.has(step.status)).length;
  const currentStep = steps.find((step) => step.status === 'running' || step.status === 'in_progress')
    ?? steps.find((step) => !DONE_STEP.has(step.status));
  return {
    stepsDone,
    stepsTotal,
    ...(stepsTotal > 0 ? { percent: Math.round((stepsDone / stepsTotal) * 100) } : {}),
    ...(currentStep ? { currentStep } : {}),
  };
}

export function useAgentLoopRun(runId: string | null | undefined, opts: UseAgentLoopRunOptions): UseAgentLoopRunResult {
  const { apiBaseUrl, idToken, transport } = opts;
  const pollMs = opts.pollMs ?? DEFAULT_AGENT_LOOP_POLL_MS;
  const frameDebounceMs = opts.frameDebounceMs ?? 250;

  const gateway = useGatewayOptional();
  const send = transport === null ? undefined : transport ? transport.send : gateway?.sendMessage as PipelineRunTransport['send'] | undefined;
  const onMessage = transport === null ? undefined : transport ? transport.onMessage : gateway?.onMessage as PipelineRunTransport['onMessage'] | undefined;
  const epoch = transport === undefined ? gateway?.sessionEpoch : undefined;

  const [loop, setLoop] = useState<AgentLoopRunView | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [stopping, setStopping] = useState(false);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // A different run starts from nothing.
  useEffect(() => {
    setLoop(undefined); setLoading(true); setNotFound(false); setError(undefined);
  }, [runId]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // The durable read — on mount, on every tick (frame, poll, Stop, refresh).
  useEffect(() => {
    if (!runId || !idToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/api/agent-loops/${encodeURIComponent(runId)}`, { headers: { Authorization: `Bearer ${idToken}` } });
        if (cancelled || !alive.current) return;
        if (res.status === 404) { setNotFound(true); setLoading(false); return; }
        if (!res.ok) { setError(`The loop could not be read (${res.status}).`); setLoading(false); return; }
        const view = (await res.json()) as AgentLoopRunView;
        if (cancelled || !alive.current) return;
        setLoop({ ...view, steps: Array.isArray(view.steps) ? view.steps : [] });
        setNotFound(false);
        setError(undefined);
        setLoading(false);
      } catch (err) {
        if (cancelled || !alive.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [runId, idToken, apiBaseUrl, tick]);

  const phase = agentLoopPhase(loop?.status);
  const over = isAgentLoopOver(phase);
  // The executor's id is what the frames carry; the loop id is what the client holds.
  const liveId = loop?.executorRunId ?? runId ?? undefined;

  // Live: a frame for this run means "re-read soon".
  useEffect(() => {
    if (!liveId || !send || !onMessage) return;
    const channel = `pipeline:run:${liveId}`;
    const ids = new Set([liveId, runId].filter((id): id is string => !!id));
    let timer: ReturnType<typeof setTimeout> | null = null;
    send({ service: 'pipeline', action: 'subscribe', channel });
    const unregister = onMessage((frame: unknown) => {
      const msg = frame as GatewayMessage & { payload?: Record<string, unknown> };
      if (!msg || msg.type !== 'pipeline:event') return;
      const id = msg.payload?.runId;
      if (typeof id !== 'string' || !ids.has(id)) return;
      if (timer) return;
      timer = setTimeout(() => { timer = null; refresh(); }, frameDebounceMs);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unregister();
      send({ service: 'pipeline', action: 'unsubscribe', channel });
    };
  }, [liveId, runId, send, onMessage, epoch, frameDebounceMs, refresh]);

  // Safety net while the loop is live.
  useEffect(() => {
    if (!runId || !idToken || pollMs <= 0 || over || notFound) return;
    const timer = setInterval(refresh, pollMs);
    return () => clearInterval(timer);
  }, [runId, idToken, pollMs, over, notFound, refresh]);

  const stop = useCallback(async (): Promise<AgentLoopStopResult> => {
    if (!runId || !idToken) return { ok: false, error: 'Not signed in.' };
    setStopping(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/agent-loops/${encodeURIComponent(runId)}/stop`, {
        method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'content-type': 'application/json' }, body: '{}',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: unknown };
        return { ok: false, status: res.status, error: typeof body.error === 'string' ? body.error : `Stop failed (${res.status}).` };
      }
      return { ok: true, status: res.status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (alive.current) { setStopping(false); refresh(); }
    }
  }, [runId, idToken, apiBaseUrl, refresh]);

  const steps = useMemo(() => loop?.steps ?? [], [loop]);
  const progress = useMemo(() => agentLoopProgress(steps), [steps]);
  const canStop = !!loop && !over && (loop.controls ? loop.controls.stop : true);

  return {
    ...(loop ? { loop } : {}),
    loading,
    notFound,
    ...(error ? { error } : {}),
    phase,
    ...(loop?.status ? { status: loop.status } : {}),
    steps,
    ...progress,
    ...(loop?.startedAt ? { startedAt: loop.startedAt } : {}),
    canStop,
    stopping,
    stop,
    canPause: false,
    pauseUnsupportedReason: loop?.controls?.pauseUnsupportedReason ?? PAUSE_UNSUPPORTED_FALLBACK,
    refresh,
  };
}

export default useAgentLoopRun;
