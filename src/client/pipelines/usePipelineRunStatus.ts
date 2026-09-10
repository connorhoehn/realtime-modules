// realtime-modules/src/client/pipelines/usePipelineRunStatus.ts
//
// Where a pipeline run is, for a card in a conversation. Ported from the
// realtime-examples app hook (frontend/src/hooks/useAgentRunStatus.ts) so any
// host that embeds the chat gets live agent-run cards without copying app code.
//
// Two sources, merged per run:
//   - Live: the gateway's `pipeline:event` frames. The firehose (`pipeline:all`)
//     is subscribed as well as each run's own channel, because a per-run
//     subscription lands AFTER the run has started and misses its first frames.
//   - Durable: `GET {apiBaseUrl}/api/pipelines/:pipelineId/runs/:runId`, once
//     on mount and then every `pollMs` while the run is not terminal. Frames
//     can be missed (a reconnect drops one); the run store is the truth.
//
// The transport is injectable so an app that owns its own socket can hand in
// `{ send, onMessage }`; an rm-native host mounted under GatewaySocketProvider
// passes nothing and the hook reads the gateway context itself.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useGatewayOptional } from '../GatewaySocketProvider';
import type { GatewayMessage } from '../types';

export type PipelineRunPhase = 'received' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'rejected';

export interface PipelineRunStatus {
  phase: PipelineRunPhase;
  /** The step in flight, as a person would read it ("Reading the document…"). */
  stepLabel?: string;
  /** One line under the phase: the result of a finished run, the reason a run paused, the error of a failed one. */
  detail?: string;
  /** The step a decision goes to while `phase === 'awaiting_approval'`. */
  approvalStepId?: string;
  /** The run's final result, lifted from a completed snapshot or frame when it carried one. */
  result?: unknown;
}

export type PipelineRunDecision = 'approve' | 'reject';

export interface PipelineRunRef { runId: string; pipelineId: string }

/** Minimal socket a host hands in when it owns its own gateway connection. */
export interface PipelineRunTransport {
  send: (frame: unknown) => void;
  onMessage: (fn: (frame: unknown) => void) => () => void;
}

export interface UsePipelineRunStatusOptions {
  /** platform-api origin, e.g. `http://localhost:3001`. */
  apiBaseUrl: string;
  /** Bearer for the snapshot reads; `null` disables polling (frames still flow). */
  idToken: string | null;
  /** A host-owned socket. Omit (or pass `undefined`) to use the nearest GatewaySocketProvider; `null` disables live frames. */
  transport?: PipelineRunTransport | null;
  /** Step-id → narration, merged over `DEFAULT_STEP_LABELS`. */
  stepLabels?: Record<string, string>;
  /** Per-pipeline overrides for step ids that collide across pipelines, merged over `DEFAULT_PIPELINE_STEP_LABELS`. */
  pipelineStepLabels?: Record<string, Record<string, string>>;
  /** Snapshot re-read interval while a run is not terminal. Default 1500. */
  pollMs?: number;
}

/** The narration people see while a step runs, keyed by step id. */
export const DEFAULT_STEP_LABELS: Record<string, string> = {
  // document-agent-edit / document-transform
  read: 'Reading the document…',
  plan: 'Deciding what to change (Haiku)…',
  review: 'Checking the plan',
  approve: 'Waiting for approval',
  apply: 'Applying the edit as a collaborator…',
  // recording-finalize
  resolve: 'Finding the call',
  persist: 'Saving the recording',
  'await-compose': 'Waiting for the composed file',
  announce: 'Posting to the conversation',
  'start-transcription': 'Starting transcription',
  // call-transcription
  transcribe: 'Transcribing the audio',
  'merge-reactions': 'Merging reactions',
  store: 'Storing the transcript',
  summarize: 'Summarising the call (Haiku)…',
  'store-summary': 'Storing the summary',
  publish: 'Publishing the transcript',
  // conversation-summarize
  'read-history': 'Reading the conversation',
};

/** Steps whose ids collide across pipelines read differently per pipeline. */
export const DEFAULT_PIPELINE_STEP_LABELS: Record<string, Record<string, string>> = {
  'conversation-summarize': { plan: 'Writing the summary (Haiku)…', apply: 'Writing the page as a collaborator…', publish: 'Posting to the conversation' },
  'diagram-generate': { plan: 'Sketching the diagram (Haiku)…', apply: 'Drawing the board', publish: 'Posting to the conversation' },
};

export interface StepLabelTables {
  stepLabels?: Record<string, string>;
  pipelineStepLabels?: Record<string, Record<string, string>>;
}

/** The label for a step: the pipeline-specific one, then the general one, then the raw id. */
export function stepLabelFor(stepId: string, pipelineId?: string, tables: StepLabelTables = {}): string {
  const perPipeline = { ...DEFAULT_PIPELINE_STEP_LABELS, ...(tables.pipelineStepLabels ?? {}) };
  const general = { ...DEFAULT_STEP_LABELS, ...(tables.stepLabels ?? {}) };
  return (pipelineId ? perPipeline[pipelineId]?.[stepId] : undefined) ?? general[stepId] ?? stepId;
}

/** "Retrying — attempt 2 of 3", or without the "of 3" when the budget is not known. */
export function retryLabel(attemptNumber: number, maxAttempts?: number): string {
  return `Retrying — attempt ${attemptNumber}${typeof maxAttempts === 'number' && maxAttempts > 0 ? ` of ${maxAttempts}` : ''}`;
}

// ---------------------------------------------------------------------------
// REST helpers (pure — no React)
// ---------------------------------------------------------------------------

async function errorFrom(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  return new Error(body.error || body.message || `${fallback} (${res.status})`);
}

/**
 * Generic authenticated POST to platform-api. `path` is appended to
 * `apiBaseUrl` verbatim (e.g. `/api/documents/doc-1/agent-edit`); the JSON
 * body comes back typed as the caller says it does.
 */
export async function requestPipelineRun<T = { runId: string; pipelineId: string }>(
  apiBaseUrl: string,
  idToken: string | null,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw await errorFrom(res, 'Could not start the run');
  return (await res.json()) as T;
}

/** Approve or reject the step a run is waiting on. Resolves when platform-api has recorded it. */
export async function approvePipelineRun(
  apiBaseUrl: string,
  idToken: string | null,
  input: { runId: string; stepId: string; decision: PipelineRunDecision; comment?: string },
): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/api/pipelines/${encodeURIComponent(input.runId)}/approvals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ stepId: input.stepId, decision: input.decision, ...(input.comment ? { comment: input.comment } : {}) }),
  });
  if (!res.ok) throw await errorFrom(res, `Could not ${input.decision} the run`);
}

// ---------------------------------------------------------------------------
// Detail lines
// ---------------------------------------------------------------------------

/**
 * The one line a finished card shows. `outputs` is keyed by step id (the run's
 * final context carries them under `steps`; the snapshot path builds the same
 * map). Recording and transcription runs finish on their publish step; the
 * document runs on their apply step.
 */
export function runStatusDetail(outputs: Record<string, unknown> | undefined): string | undefined {
  const o = outputs ?? {};
  const step = (id: string) => (o[id] ?? {}) as Record<string, unknown>;
  const publish = step('publish');
  if (typeof publish.words === 'number') return publish.words > 0 ? `Transcript ready — ${publish.words} word${publish.words === 1 ? '' : 's'}${publish.appended ? ', added to the document' : ''}` : 'No speech was found';
  const announce = step('announce');
  if (typeof announce.posted === 'boolean') return 'Recording ready';
  const apply = step('apply');
  if (typeof apply.title === 'string') return `Renamed to “${apply.title}”`;
  if (typeof apply.applied === 'number') return apply.applied > 0 ? `${apply.applied} change${apply.applied === 1 ? '' : 's'} applied` : (typeof apply.reason === 'string' ? apply.reason : 'No changes were needed');
  return undefined;
}

function outputsOfContext(output: unknown): Record<string, unknown> | undefined {
  const o = (output ?? {}) as Record<string, unknown>;
  return (o.steps as Record<string, unknown> | undefined) ?? o;
}

/** Why the run paused, as the review step said it. */
function approvalReason(context: Record<string, unknown> | undefined, outputs: Record<string, unknown> | undefined): string | undefined {
  const review = ((outputs?.review ?? {}) as Record<string, unknown>);
  if (typeof review.reason === 'string' && review.reason) return review.reason;
  return typeof context?.reason === 'string' && context.reason ? context.reason : undefined;
}

/** "Rejected by Grace" when the decision names someone; a timeout or a nameless record is just "Rejected". */
function rejectedDetail(rejection: unknown): string {
  const r = (rejection ?? {}) as { userId?: unknown; displayName?: unknown; comment?: unknown };
  const who = typeof r.displayName === 'string' && r.displayName ? r.displayName : (typeof r.userId === 'string' && r.userId && r.userId !== 'system:timeout' ? r.userId : undefined);
  const base = who ? `Rejected by ${who}` : (r.userId === 'system:timeout' ? 'Rejected — nobody approved in time' : 'Rejected');
  return typeof r.comment === 'string' && r.comment ? `${base} — ${r.comment}` : base;
}

/**
 * The run's result, when the record carries one. A top-level `result` wins;
 * otherwise the final step's output (the last step in the list that finished
 * with an output) — that is what the pipeline produced.
 */
function resultOf(snapOrFrame: { result?: unknown; output?: unknown }, stepList: Step[]): unknown {
  if (snapOrFrame.result !== undefined) return snapOrFrame.result;
  const ctx = snapOrFrame.output as Record<string, unknown> | undefined;
  if (ctx && ctx.result !== undefined) return ctx.result;
  for (let i = stepList.length - 1; i >= 0; i -= 1) {
    const s = stepList[i];
    if (s.output !== undefined && (s.status === undefined || s.status === 'completed')) return s.output;
  }
  return undefined;
}

const TERMINAL = new Set<PipelineRunPhase>(['completed', 'failed', 'rejected']);

/** `pipeline:run:completed` and `pipeline.run.completed` are the same event. */
export function normalizeEventType(eventType: unknown): string | undefined {
  if (typeof eventType !== 'string' || !eventType) return undefined;
  return eventType.replace(/:/g, '.');
}

type Step = { stepId?: string; nodeId?: string; status?: string; output?: unknown; attempts?: Array<{ attemptNumber?: number; error?: string }> };

export interface PipelineRunSnapshot {
  status?: string;
  currentStepIds?: string[];
  steps?: Step[] | Record<string, Step>;
  error?: { message?: string } | string;
  context?: Record<string, unknown>;
  rejection?: unknown;
  result?: unknown;
  output?: unknown;
  pipelineDefinitionSnapshot?: { nodes?: Array<{ id: string; data?: { retryPolicy?: { maxAttempts?: number } } }> };
}

/** The card's status from a run snapshot; `undefined` when the snapshot says nothing new (pending). */
export function statusFromSnapshot(snap: PipelineRunSnapshot, prev?: PipelineRunStatus, pipelineId?: string, tables: StepLabelTables = {}): PipelineRunStatus | undefined {
  const status = String(snap.status ?? '');
  // The snapshot keys steps by node id; older shapes carried an array.
  const stepList: Step[] = Array.isArray(snap.steps) ? snap.steps : Object.entries(snap.steps ?? {}).map(([id, st]) => ({ stepId: id, ...st }));
  const outputs = Object.fromEntries(stepList.map((s) => [s.stepId ?? s.nodeId ?? '', s.output]));
  if (status === 'completed') {
    const result = resultOf(snap, stepList);
    return { phase: 'completed', detail: runStatusDetail(outputs) ?? 'Done', ...(result !== undefined ? { result } : {}) };
  }
  if (status === 'rejected') return { phase: 'rejected', detail: rejectedDetail(snap.rejection) };
  if (status === 'failed' || status === 'cancelled') return { phase: 'failed', detail: typeof snap.error === 'string' ? snap.error : snap.error?.message ?? 'The run failed' };
  if (status === 'awaiting_approval') {
    const step = stepList.find((s) => s.status === 'awaiting') ?? stepList.find((s) => (s.stepId ?? s.nodeId) === 'approve');
    return { phase: 'awaiting_approval', approvalStepId: step?.stepId ?? step?.nodeId ?? 'approve', detail: approvalReason(snap.context, outputs) };
  }
  if (status === 'running') {
    // The run store knows which step is in flight — narrate it, and a retry as a retry.
    const currentId = snap.currentStepIds?.[0] ?? stepList.find((s) => s.status === 'running')?.stepId;
    const current = currentId ? stepList.find((s) => (s.stepId ?? s.nodeId) === currentId) : undefined;
    const attempts = current?.attempts ?? [];
    const latest = attempts.length > 0 ? attempts[attempts.length - 1]?.attemptNumber ?? attempts.length : 0;
    if (currentId && latest > 1) {
      const max = snap.pipelineDefinitionSnapshot?.nodes?.find((n) => n.id === currentId)?.data?.retryPolicy?.maxAttempts;
      return { phase: 'running', stepLabel: `${stepLabelFor(currentId, pipelineId, tables)} · ${retryLabel(latest, max)}` };
    }
    return { phase: 'running', stepLabel: currentId ? stepLabelFor(currentId, pipelineId, tables) : prev?.stepLabel };
  }
  return undefined;
}

/** The card's status after one live frame; `undefined` when the frame is not about the card. */
export function statusFromEvent(eventType: string | undefined, p: Record<string, unknown>, prev: PipelineRunStatus | undefined, pipelineId?: string, tables: StepLabelTables = {}): PipelineRunStatus | undefined {
  const stepId = typeof p.stepId === 'string' ? p.stepId : '';
  switch (normalizeEventType(eventType)) {
    case 'pipeline.run.started': return { phase: 'running' };
    case 'pipeline.step.started': return { phase: 'running', stepLabel: stepLabelFor(stepId, pipelineId, tables) };
    case 'pipeline.step.attempt.started': {
      const n = typeof p.attemptNumber === 'number' ? p.attemptNumber : 1;
      if (n <= 1) return undefined;
      return { phase: 'running', stepLabel: `${stepLabelFor(stepId, pipelineId, tables)} · ${retryLabel(n, typeof p.maxAttempts === 'number' ? p.maxAttempts : undefined)}` };
    }
    case 'pipeline.approval.requested':
      return { phase: 'awaiting_approval', approvalStepId: stepId || 'approve', detail: prev?.detail };
    case 'pipeline.step.completed': {
      if (stepId === 'review') {
        const out = (p.output ?? {}) as Record<string, unknown>;
        // The review's reason is what the approval card will say; keep it around for the request frame.
        return out.needsApproval === true ? { phase: 'running', stepLabel: stepLabelFor('approve', pipelineId, tables), detail: typeof out.reason === 'string' ? out.reason : undefined } : undefined;
      }
      if (stepId === 'apply' || stepId === 'publish' || stepId === 'announce') return { phase: 'running', stepLabel: 'Finishing', detail: runStatusDetail({ [stepId]: p.output }) };
      return undefined;
    }
    case 'pipeline.run.completed': {
      if (p.status === 'rejected') return { phase: 'rejected', detail: rejectedDetail(p.rejection) };
      const result = resultOf(p as { result?: unknown; output?: unknown }, []);
      return {
        phase: 'completed',
        detail: (prev?.phase === 'running' ? prev.detail : undefined) ?? runStatusDetail(outputsOfContext(p.output)) ?? 'Done',
        ...(result !== undefined ? { result } : {}),
      };
    }
    case 'pipeline.run.failed':
    case 'pipeline.step.failed': return { phase: 'failed', detail: typeof p.error === 'string' ? p.error : (typeof (p.error as { message?: unknown } | undefined)?.message === 'string' ? (p.error as { message: string }).message : 'The run failed') };
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export const DEFAULT_POLL_MS = 1500;

export function usePipelineRunStatus(
  runs: readonly PipelineRunRef[],
  opts: UsePipelineRunStatusOptions,
): (runId: string) => PipelineRunStatus | undefined {
  const { apiBaseUrl, idToken, transport, stepLabels, pipelineStepLabels } = opts;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  // Hooks cannot be conditional, so the context is always read; it is only
  // USED when the host handed in no transport of its own.
  const gateway = useGatewayOptional();
  const send: PipelineRunTransport['send'] | undefined =
    transport === null ? undefined : transport ? transport.send : gateway?.sendMessage as PipelineRunTransport['send'] | undefined;
  const onMessage: PipelineRunTransport['onMessage'] | undefined =
    transport === null ? undefined : transport ? transport.onMessage : gateway?.onMessage as PipelineRunTransport['onMessage'] | undefined;

  const [statuses, setStatuses] = useState<Record<string, PipelineRunStatus>>({});
  const fetched = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  const key = runs.map((r) => r.runId).sort().join(',');

  // Label tables travel by ref so a caller passing a fresh literal each render
  // does not resubscribe the socket.
  const tablesRef = useRef<StepLabelTables>({ stepLabels, pipelineStepLabels });
  tablesRef.current = { stepLabels, pipelineStepLabels };
  const runsRef = useRef(runs);
  runsRef.current = runs;

  // Live: one subscription per run in view, plus the firehose.
  useEffect(() => {
    if (runs.length === 0 || !send || !onMessage) return;
    send({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:all' });
    for (const r of runs) send({ service: 'pipeline', action: 'subscribe', channel: `pipeline:run:${r.runId}` });
    const unregister = onMessage((frame: unknown) => {
      const msg = frame as GatewayMessage & { eventType?: unknown; payload?: Record<string, unknown> };
      if (!msg || msg.type !== 'pipeline:event') return;
      const p = msg.payload ?? {};
      const runId = typeof p.runId === 'string' ? p.runId : null;
      const run = runId ? runsRef.current.find((r) => r.runId === runId) : undefined;
      if (!runId || !run) return;
      const eventType = normalizeEventType(msg.eventType);
      setStatuses((prev) => {
        const next = statusFromEvent(eventType, p, prev[runId], run.pipelineId, tablesRef.current);
        return next ? { ...prev, [runId]: next } : prev;
      });
    });
    return () => {
      unregister();
      for (const r of runs) send({ service: 'pipeline', action: 'unsubscribe', channel: `pipeline:run:${r.runId}` });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, send, onMessage]);

  // Once (and on every tick): the durable answer, for anyone arriving late.
  useEffect(() => {
    if (!idToken) return;
    for (const r of runs) {
      if (fetched.current.has(r.runId)) continue;
      fetched.current.add(r.runId);
      void (async () => {
        try {
          const res = await fetch(`${apiBaseUrl}/api/pipelines/${encodeURIComponent(r.pipelineId)}/runs/${encodeURIComponent(r.runId)}`, { headers: { Authorization: `Bearer ${idToken}` } });
          if (!res.ok) return;
          const snap = (await res.json()) as PipelineRunSnapshot;
          setStatuses((prev) => {
            if (TERMINAL.has(prev[r.runId]?.phase)) return prev;
            const next = statusFromSnapshot(snap, prev[r.runId], r.pipelineId, tablesRef.current);
            return next ? { ...prev, [r.runId]: next } : prev;
          });
        } catch { /* the live frames still tell the story */ }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, idToken, tick, apiBaseUrl]);

  // While a run is not terminal, re-read the snapshot every `pollMs`.
  useEffect(() => {
    if (!idToken || pollMs <= 0) return;
    const pending = runs.filter((r) => !TERMINAL.has(statuses[r.runId]?.phase));
    if (pending.length === 0) return;
    const timer = setInterval(() => {
      for (const r of pending) fetched.current.delete(r.runId);
      setTick((t) => t + 1);
    }, pollMs);
    return () => clearInterval(timer);
  }, [runs, statuses, idToken, pollMs]);

  return useCallback((runId: string) => statuses[runId], [statuses]);
}

export default usePipelineRunStatus;
