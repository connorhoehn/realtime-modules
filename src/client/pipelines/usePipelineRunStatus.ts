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
//
// A run that SUGGESTED its edit (apply step `mode: 'suggest'`) completes with a
// `suggestion` and waits on a person: the `pipeline.run.reviewed` frame, or the
// snapshot's `review`, settles it to "Accepted by …" / "Rejected by …".
//
// A card can EXPAND: `details` carries the run's steps (ordered, labelled, with
// a status each), the document it worked on (id, title, a snippet), and the
// ops the apply step emitted — derived from the snapshot's step outputs and
// kept current by step frames. Details are only ever added to, never cleared
// by a sparser snapshot.

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
  /** Set when a completed run SUGGESTED its edit instead of applying it — the card offers accept / reject until `review` lands. */
  suggestion?: PipelineRunSuggestion;
  /** The decision on a suggestion, once someone made one. A reviewed run is fully settled. */
  review?: PipelineRunReview;
  /** A completed run that changed nothing (apply `applied === 0` — the model chose `skip`); `detail` is its reason. */
  noop?: boolean;
  /** What an expanded card shows: the steps, the document, what changed. Accumulates across snapshots and frames. */
  details?: PipelineRunDetails;
}

export type PipelineRunStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'awaiting';

/** One step in an expanded card's timeline. */
export interface PipelineRunStepDetail {
  id: string;
  /** The narration for the step without its trailing "…" ("Reading the document"). */
  label: string;
  status: PipelineRunStepStatus;
}

/** One change the apply step made, flattened from platform-api's DocOp shapes. `text`/`reason` are cut at 140 chars. */
export interface PipelineRunOpDetail {
  op: string;
  text?: string;
  index?: number;
  /** The block an `appendBlock`/`insertBlock` op added — 'paragraph' | 'heading' | 'horizontalRule' — so a card can say "a divider" rather than quote nothing. */
  kind?: string;
  /** A heading op's level (1–6). */
  level?: number;
  macroName?: string;
  typeName?: string;
  reason?: string;
}

/** The document a run worked on. */
export interface PipelineRunDocumentDetail {
  id: string;
  title?: string;
  /** The first ~200 chars of the document as the run read it (outline prefixes stripped), or of the first block it appended. */
  snippet?: string;
}

export interface PipelineRunDetails {
  steps?: PipelineRunStepDetail[];
  ops?: PipelineRunOpDetail[];
  document?: PipelineRunDocumentDetail;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

/** A completed run whose apply step ran in `mode: 'suggest'` — the changes are pending as suggestions in the document. */
export interface PipelineRunSuggestion {
  /** The suggestion bucket in the document, `<user>@<bucket>`; the review names it. */
  key: string;
  /** The document the suggestions live in, when the run's trigger or context said. */
  documentId?: string;
  /** How many changes were suggested. */
  applied: number;
}

export type PipelineReviewDecision = 'accept' | 'reject';

/** Who decided what about a run's suggestions, and when. */
export interface PipelineRunReview {
  decision: PipelineReviewDecision;
  /** The reviewer's user id. */
  by: string;
  /** The reviewer's display name, when the record carried one. */
  byName?: string;
  /** ISO timestamp of the decision. */
  at: string;
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
  /**
   * Re-read interval for a completed run whose suggestions are still unreviewed —
   * the review usually arrives as a `pipeline.run.reviewed` frame, so this is
   * a slow safety net (platform-api rate-limits GETs per user). Default 15000;
   * `0` disables it (frames only).
   */
  reviewPollMs?: number;
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

/** The error a REST helper throws: the server's message, with the HTTP status attached (`409` = already reviewed). */
export type PipelineRunRequestError = Error & { status: number };

async function errorFrom(res: Response, fallback: string): Promise<PipelineRunRequestError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  return Object.assign(new Error(body.error || body.message || `${fallback} (${res.status})`), { status: res.status });
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

export interface ReviewPipelineRunInput {
  pipelineId: string;
  runId: string;
  decision: PipelineReviewDecision;
  /** The suggestion bucket the run wrote (`PipelineRunSuggestion.key`). */
  suggestionKey: string;
  documentId: string;
  comment?: string;
  /** The reviewer's display name, so the card can say "Accepted by Grace" without a profile lookup. */
  byName?: string;
  /** Ask platform-api to accept/reject the suggestions in the document itself (as a second run) instead of the client doing it through the CRDT. */
  applyServerSide?: boolean;
}

export interface ReviewPipelineRunResponse {
  runId: string;
  pipelineId: string;
  review: PipelineRunReview & { suggestionKey: string; documentId: string; comment?: string; appliedByRunId?: string };
  /** Present when `applyServerSide` was asked for: what the server did. */
  applied?: unknown;
}

/**
 * Accept or reject the suggestions a completed run left in a document.
 * Resolves with platform-api's record; throws a `PipelineRunRequestError`
 * on a non-2xx — `status === 409` means someone already reviewed it.
 */
export async function reviewPipelineRun(
  apiBaseUrl: string,
  idToken: string | null,
  input: ReviewPipelineRunInput,
): Promise<ReviewPipelineRunResponse> {
  const { pipelineId, runId, ...body } = input;
  const res = await fetch(`${apiBaseUrl}/api/pipelines/${encodeURIComponent(pipelineId)}/runs/${encodeURIComponent(runId)}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))),
  });
  if (!res.ok) throw await errorFrom(res, `Could not ${input.decision} the suggestions`);
  return (await res.json()) as ReviewPipelineRunResponse;
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
  if (typeof apply.applied === 'number') {
    if (apply.applied <= 0) return typeof apply.reason === 'string' ? apply.reason : 'No changes were needed';
    return `${apply.applied} change${apply.applied === 1 ? '' : 's'} ${apply.mode === 'suggest' ? 'suggested' : 'applied'}`;
  }
  return undefined;
}

/** "Accepted by Grace" / "Rejected by Grace" — the name, falling back to the id. */
export function reviewDetail(review: PipelineRunReview): string {
  return `${review.decision === 'accept' ? 'Accepted' : 'Rejected'} by ${review.byName || review.by}`;
}

/** A well-formed review record from a snapshot's `review` or a `pipeline.run.reviewed` payload; `undefined` otherwise. */
export function reviewOf(raw: unknown): PipelineRunReview | undefined {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.decision !== 'accept' && r.decision !== 'reject') return undefined;
  const by = typeof r.by === 'string' ? r.by : '';
  const at = typeof r.at === 'string' ? r.at : new Date(0).toISOString();
  return { decision: r.decision, by, at, ...(typeof r.byName === 'string' && r.byName ? { byName: r.byName } : {}) };
}

/** The first string among the candidates — the run's documentId lives in different places per source. */
function firstString(...candidates: unknown[]): string | undefined {
  return candidates.find((c): c is string => typeof c === 'string' && c.length > 0);
}

/** The document a run worked on: the trigger, then the context, then the apply output. */
function documentIdOf(context: Record<string, unknown> | undefined, apply: Record<string, unknown>): string | undefined {
  const c = context ?? {};
  const trigger = (c.trigger ?? {}) as Record<string, unknown>;
  const input = (c.input ?? {}) as Record<string, unknown>;
  return firstString(c.documentId, trigger.documentId, input.documentId, apply.documentId);
}

/** The suggestion a completed run left behind, when its apply step ran in `mode: 'suggest'`. */
export function suggestionOf(outputs: Record<string, unknown> | undefined, context?: Record<string, unknown>): PipelineRunSuggestion | undefined {
  const apply = ((outputs?.apply ?? {}) as Record<string, unknown>);
  if (apply.mode !== 'suggest' || typeof apply.suggestionKey !== 'string' || !apply.suggestionKey) return undefined;
  const documentId = documentIdOf(context, apply);
  return { key: apply.suggestionKey, applied: typeof apply.applied === 'number' ? apply.applied : 0, ...(documentId ? { documentId } : {}) };
}

/** A completed status with its suggestion and review folded in — the review's line wins over the run's own. */
function withReview(base: PipelineRunStatus, suggestion: PipelineRunSuggestion | undefined, review: PipelineRunReview | undefined): PipelineRunStatus {
  return {
    ...base,
    ...(suggestion ? { suggestion } : {}),
    ...(review ? { review, detail: reviewDetail(review) } : {}),
  };
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

/** A completed run whose suggestions nobody has accepted or rejected yet — terminal for the phase, not for the card. */
export function isAwaitingReview(status: PipelineRunStatus | undefined): boolean {
  return status?.phase === 'completed' && !!status.suggestion && !status.review;
}

/** `pipeline:run:completed` and `pipeline.run.completed` are the same event. */
export function normalizeEventType(eventType: unknown): string | undefined {
  if (typeof eventType !== 'string' || !eventType) return undefined;
  return eventType.replace(/:/g, '.');
}

type Step = {
  stepId?: string;
  nodeId?: string;
  status?: string;
  output?: unknown;
  error?: { message?: string } | string;
  startedAt?: string;
  completedAt?: string;
  attempts?: Array<{ attemptNumber?: number; error?: string }>;
};

export interface PipelineRunSnapshot {
  status?: string;
  currentStepIds?: string[];
  steps?: Step[] | Record<string, Step>;
  error?: { message?: string } | string;
  context?: Record<string, unknown>;
  trigger?: Record<string, unknown>;
  rejection?: unknown;
  result?: unknown;
  output?: unknown;
  startedAt?: string;
  completedAt?: string;
  /** Present once someone accepted or rejected the run's suggestions. */
  review?: unknown;
  pipelineDefinitionSnapshot?: { nodes?: Array<{ id: string; data?: { retryPolicy?: { maxAttempts?: number } } }> };
}

/** The snapshot's steps as a list, each carrying its id (the store keys them by node id; older shapes carried an array). */
function stepListOf(snap: PipelineRunSnapshot): Step[] {
  return Array.isArray(snap.steps) ? snap.steps : Object.entries(snap.steps ?? {}).map(([id, st]) => ({ stepId: id, ...st }));
}

/** An error's message, whether the record carried a string or `{ message }`. */
function errorMessage(err: unknown): string | undefined {
  if (typeof err === 'string' && err) return err;
  const m = (err as { message?: unknown } | undefined)?.message;
  return typeof m === 'string' && m ? m : undefined;
}

/** The message of a failed run: the run's own error, then the failed step's, then its last attempt's. */
function failureMessage(snap: PipelineRunSnapshot, stepList: Step[]): string | undefined {
  const own = errorMessage(snap.error);
  if (own) return own;
  const failed = stepList.find((s) => s.status === 'failed') ?? stepList.find((s) => s.error !== undefined);
  if (!failed) return undefined;
  const attempts = failed.attempts ?? [];
  return errorMessage(failed.error) ?? errorMessage(attempts[attempts.length - 1]?.error);
}

// ---------------------------------------------------------------------------
// Details — what an expanded card shows
// ---------------------------------------------------------------------------

const OP_TEXT_MAX = 140;
const SNIPPET_MAX = 200;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The step's label for a timeline: the narration without its trailing ellipsis. */
export function stepTimelineLabel(stepId: string, pipelineId?: string, tables: StepLabelTables = {}): string {
  return stepLabelFor(stepId, pipelineId, tables).replace(/(\.{3}|…)+\s*$/u, '').trimEnd() || stepId;
}

function stepStatusOf(raw: unknown, running: boolean): PipelineRunStepStatus {
  if (running) return 'running';
  switch (raw) {
    case 'awaiting': case 'running': case 'completed': case 'failed': case 'skipped': return raw;
    case 'success': return 'completed';
    case 'error': return 'failed';
    default: return 'pending';
  }
}

/**
 * The snapshot's steps in the order a person reads them: the trigger first,
 * then by `startedAt` among the steps that have one — a step without a
 * timestamp keeps its place in the record. The definition's node order is
 * not known here.
 */
export function stepsFromSnapshot(snap: PipelineRunSnapshot, pipelineId?: string, tables: StepLabelTables = {}): PipelineRunStepDetail[] | undefined {
  const list = stepListOf(snap).map((s) => ({ ...s, id: s.stepId ?? s.nodeId ?? '' })).filter((s) => s.id);
  if (list.length === 0) return undefined;
  const trigger = list.filter((s) => s.id === 'trigger');
  const rest = list.filter((s) => s.id !== 'trigger');
  const stamped = rest.filter((s) => typeof s.startedAt === 'string').sort((a, b) => (a.startedAt as string).localeCompare(b.startedAt as string));
  let next = 0;
  const ordered = rest.map((s) => (typeof s.startedAt === 'string' ? stamped[next++] : s));
  const current = new Set(snap.currentStepIds ?? []);
  return [...trigger, ...ordered].map((s) => ({
    id: s.id,
    label: stepTimelineLabel(s.id, pipelineId, tables),
    status: stepStatusOf(s.status, current.has(s.id) && s.status !== 'awaiting' && s.status !== 'completed' && s.status !== 'failed'),
  }));
}

/** platform-api's DocOp objects, flattened for a card: text cut short, only the fields that name what happened. */
export function opsFromApplyOutput(applyOutput: unknown): PipelineRunOpDetail[] | undefined {
  const raw = (applyOutput as { ops?: unknown } | undefined)?.ops;
  if (!Array.isArray(raw)) return undefined;
  const ops: PipelineRunOpDetail[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    if (typeof o.op !== 'string' || !o.op) continue;
    const out: PipelineRunOpDetail = { op: o.op };
    if (typeof o.text === 'string') out.text = truncate(o.text, OP_TEXT_MAX);
    if (typeof o.index === 'number') out.index = o.index;
    if (typeof o.kind === 'string' && o.kind) out.kind = o.kind;
    if (typeof o.level === 'number') out.level = o.level;
    if (typeof o.macroName === 'string' && o.macroName) out.macroName = o.macroName;
    if (typeof o.typeName === 'string' && o.typeName) out.typeName = o.typeName;
    if (typeof o.reason === 'string' && o.reason) out.reason = truncate(o.reason, OP_TEXT_MAX);
    ops.push(out);
  }
  return ops;
}

/**
 * A snippet of the document from the read step's outline — `title: …` dropped,
 * each `#N kind(h2)(macro): ` prefix stripped, `(empty)` lines skipped — cut
 * to ~200 chars.
 */
export function snippetFromOutline(outline: unknown): string | undefined {
  if (typeof outline !== 'string' || !outline.trim()) return undefined;
  const lines = outline
    .split('\n')
    .filter((line) => !/^title:\s/.test(line))
    // A macro block's text is its YAML body (attachment names, sizes, URLs) and the
    // level-1 heading repeats the title — neither reads as a preview of the page.
    .filter((line) => !/^#\d+\s+macro\(/.test(line) && !/^#\d+\s+heading\(h1\):/.test(line))
    .map((line) => line.replace(/^#\d+\s+[^:]*:\s*/, '').trim())
    .filter((line) => line && line !== '(empty)');
  const text = lines.join(' ').replace(/\s+/g, ' ').trim();
  return text ? truncate(text, SNIPPET_MAX) : undefined;
}

/** The document a run worked on, from the trigger/context/apply output; title and snippet from the read step, falling back to what apply wrote. */
export function documentFromOutputs(outputs: Record<string, unknown> | undefined, context?: Record<string, unknown>): PipelineRunDocumentDetail | undefined {
  const o = outputs ?? {};
  const step = (id: string) => (o[id] ?? {}) as Record<string, unknown>;
  const trigger = step('trigger');
  const read = step('read');
  const apply = step('apply');
  const id = firstString(trigger.documentId, ...(context ? [context.documentId, (context.trigger as Record<string, unknown> | undefined)?.documentId, (context.input as Record<string, unknown> | undefined)?.documentId] : []), apply.documentId, read.documentId);
  if (!id) return undefined;
  const title = firstString(read.documentTitle, apply.title, context?.documentTitle);
  const firstAppend = (opsFromApplyOutput(apply) ?? []).find((op) => (op.op === 'appendBlock' || op.op === 'insertBlock') && op.text);
  const snippet = snippetFromOutline(read.documentOutline) ?? (firstAppend?.text ? truncate(firstAppend.text, SNIPPET_MAX) : undefined);
  return { id, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) };
}

/** `next` laid over `prev`, field by field — a field the newer source lacks keeps the older value. Never clears. */
export function mergeDetails(prev: PipelineRunDetails | undefined, next: PipelineRunDetails | undefined): PipelineRunDetails | undefined {
  if (!next) return prev;
  if (!prev) return next;
  const merged: PipelineRunDetails = { ...prev };
  if (next.steps && next.steps.length > 0) merged.steps = next.steps;
  if (next.ops) merged.ops = next.ops;
  if (next.document) merged.document = { ...(prev.document ?? {}), ...next.document };
  if (next.startedAt) merged.startedAt = next.startedAt;
  if (next.completedAt) merged.completedAt = next.completedAt;
  if (next.error) merged.error = next.error;
  return merged;
}

/** The expanded card's details from a run snapshot, laid over what was already known. */
export function detailsFromSnapshot(snap: PipelineRunSnapshot, prev?: PipelineRunDetails, pipelineId?: string, tables: StepLabelTables = {}): PipelineRunDetails | undefined {
  const stepList = stepListOf(snap);
  const outputs = Object.fromEntries(stepList.map((s) => [s.stepId ?? s.nodeId ?? '', s.output]));
  const context = { ...(snap.trigger ? { trigger: snap.trigger } : {}), ...(snap.context ?? {}) };
  const status = String(snap.status ?? '');
  const next: PipelineRunDetails = {};
  const steps = stepsFromSnapshot(snap, pipelineId, tables);
  if (steps) next.steps = steps;
  const ops = opsFromApplyOutput(outputs.apply);
  if (ops) next.ops = ops;
  const document = documentFromOutputs(outputs, context);
  if (document) next.document = document;
  if (typeof snap.startedAt === 'string' && snap.startedAt) next.startedAt = snap.startedAt;
  if (typeof snap.completedAt === 'string' && snap.completedAt) next.completedAt = snap.completedAt;
  const error = status === 'failed' || status === 'cancelled' ? failureMessage(snap, stepList) : errorMessage(snap.error);
  if (error) next.error = error;
  return mergeDetails(prev, Object.keys(next).length > 0 ? next : undefined);
}

/** One step's status changed in a frame: update it in place, or add it when the timeline had not seen it. */
function withStepStatus(details: PipelineRunDetails | undefined, stepId: string, status: PipelineRunStepStatus, pipelineId?: string, tables: StepLabelTables = {}): PipelineRunDetails | undefined {
  if (!stepId) return details;
  const steps = details?.steps ?? [];
  const idx = steps.findIndex((s) => s.id === stepId);
  const nextSteps = idx >= 0
    ? steps.map((s, i) => (i === idx ? { ...s, status } : s))
    : [...steps, { id: stepId, label: stepTimelineLabel(stepId, pipelineId, tables), status }];
  return { ...(details ?? {}), steps: nextSteps };
}

/** What a live frame adds to the details: a step's status, the apply ops, the document, an error. */
function detailsFromEvent(eventType: string | undefined, p: Record<string, unknown>, prev: PipelineRunDetails | undefined, pipelineId?: string, tables: StepLabelTables = {}): PipelineRunDetails | undefined {
  const stepId = typeof p.stepId === 'string' ? p.stepId : '';
  const at = typeof p.at === 'string' ? p.at : undefined;
  switch (eventType) {
    case 'pipeline.run.started': return at ? mergeDetails(prev, { startedAt: at }) : prev;
    case 'pipeline.step.started': return withStepStatus(prev, stepId, 'running', pipelineId, tables);
    case 'pipeline.step.skipped': return withStepStatus(prev, stepId, 'skipped', pipelineId, tables);
    case 'pipeline.approval.requested': return withStepStatus(prev, stepId || 'approve', 'awaiting', pipelineId, tables);
    case 'pipeline.step.completed': {
      const base = withStepStatus(prev, stepId, 'completed', pipelineId, tables);
      const outputs = stepId ? { [stepId]: p.output } : {};
      const patch: PipelineRunDetails = {};
      if (stepId === 'apply') { const ops = opsFromApplyOutput(p.output); if (ops) patch.ops = ops; }
      const document = documentFromOutputs(outputs, p);
      if (document) patch.document = document;
      return mergeDetails(base, Object.keys(patch).length > 0 ? patch : undefined);
    }
    case 'pipeline.step.failed': {
      const base = withStepStatus(prev, stepId, 'failed', pipelineId, tables);
      const error = errorMessage(p.error);
      return mergeDetails(base, error ? { error } : undefined);
    }
    case 'pipeline.run.failed': {
      const error = errorMessage(p.error);
      const nodeId = (p.error as { nodeId?: unknown } | undefined)?.nodeId;
      const base = typeof nodeId === 'string' && nodeId && !nodeId.startsWith('(') ? withStepStatus(prev, nodeId, 'failed', pipelineId, tables) : prev;
      const patch: PipelineRunDetails = { ...(error ? { error } : {}), ...(at ? { completedAt: at } : {}) };
      return mergeDetails(base, Object.keys(patch).length > 0 ? patch : undefined);
    }
    case 'pipeline.run.completed': {
      const outputs = outputsOfContext(p.output);
      const patch: PipelineRunDetails = {};
      const ops = opsFromApplyOutput(outputs?.apply);
      if (ops) patch.ops = ops;
      const document = documentFromOutputs(outputs, { ...p, ...((p.output ?? {}) as Record<string, unknown>) });
      if (document) patch.document = document;
      if (at) patch.completedAt = at;
      const error = p.status === 'failed' || p.status === 'cancelled' ? errorMessage(p.error) : undefined;
      if (error) patch.error = error;
      return mergeDetails(prev, Object.keys(patch).length > 0 ? patch : undefined);
    }
    default: return prev;
  }
}

/** `applied === 0` on the apply step: the run changed nothing (the model chose `skip`, or there was nothing to do). */
function isNoop(outputs: Record<string, unknown> | undefined): boolean {
  const apply = ((outputs?.apply ?? {}) as Record<string, unknown>);
  if (apply.applied !== 0) return false;
  // An OPTIONAL apply step that had no document to write ("skipped: 'no document on
  // this run'") is not the run declining to change anything — the transcript or the
  // search still did its work. Only a real skip (a reason) or a plain empty plan counts.
  if (typeof apply.skipped === 'string') return false;
  if (outputs && ('publish' in outputs) && !('plan' in outputs)) return false;
  return true;
}

/** A card is only a placeholder when nobody has said anything specific yet. */
const PLACEHOLDER_DETAILS = new Set(['Done', 'The run failed', undefined]);

/** The card's status from a run snapshot; `undefined` when the snapshot says nothing new (pending). */
export function statusFromSnapshot(snap: PipelineRunSnapshot, prev?: PipelineRunStatus, pipelineId?: string, tables: StepLabelTables = {}): PipelineRunStatus | undefined {
  const phase = phaseFromSnapshot(snap, prev, pipelineId, tables);
  if (!phase) return undefined;
  const details = detailsFromSnapshot(snap, prev?.details, pipelineId, tables);
  return details ? { ...phase, details } : phase;
}

function phaseFromSnapshot(snap: PipelineRunSnapshot, prev?: PipelineRunStatus, pipelineId?: string, tables: StepLabelTables = {}): PipelineRunStatus | undefined {
  const status = String(snap.status ?? '');
  const stepList = stepListOf(snap);
  const outputs = Object.fromEntries(stepList.map((s) => [s.stepId ?? s.nodeId ?? '', s.output]));
  if (status === 'completed') {
    const result = resultOf(snap, stepList);
    const base: PipelineRunStatus = {
      phase: 'completed',
      detail: runStatusDetail(outputs) ?? 'Done',
      ...(result !== undefined ? { result } : {}),
      ...(isNoop(outputs) ? { noop: true } : {}),
    };
    // The snapshot's review wins; a snapshot that has not caught up yet must not clear one already learned from a frame.
    return withReview(base, suggestionOf(outputs, { ...(snap.trigger ? { trigger: snap.trigger } : {}), ...(snap.context ?? {}) }) ?? prev?.suggestion, reviewOf(snap.review) ?? prev?.review);
  }
  if (status === 'rejected') return { phase: 'rejected', detail: rejectedDetail(snap.rejection) };
  if (status === 'failed' || status === 'cancelled') return { phase: 'failed', detail: failureMessage(snap, stepList) ?? 'The run failed' };
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

/**
 * A terminal status learned from a frame, filled in from the snapshot that
 * arrives after it: a placeholder line ("Done" / "The run failed") gives way
 * to the snapshot's, a missing result/suggestion/review/noop is taken, and
 * the details merge. The phase itself is never walked back. Returns `cur`
 * itself when nothing changed.
 */
export function enrichTerminalStatus(cur: PipelineRunStatus, snap: PipelineRunSnapshot, pipelineId?: string, tables: StepLabelTables = {}): PipelineRunStatus {
  const fromSnap = statusFromSnapshot(snap, cur, pipelineId, tables);
  const samePhase = fromSnap?.phase === cur.phase;
  const review = cur.review ?? (samePhase ? fromSnap?.review : reviewOf(snap.review));
  const suggestion = cur.suggestion ?? (cur.phase === 'completed' ? fromSnap?.suggestion : undefined);
  const details = mergeDetails(cur.details, fromSnap?.details ?? detailsFromSnapshot(snap, undefined, pipelineId, tables));
  const next: PipelineRunStatus = withReview({ ...cur }, suggestion, review);
  if (samePhase && fromSnap) {
    if (PLACEHOLDER_DETAILS.has(cur.detail) && fromSnap.detail && !PLACEHOLDER_DETAILS.has(fromSnap.detail) && !review) next.detail = fromSnap.detail;
    if (next.result === undefined && fromSnap.result !== undefined) next.result = fromSnap.result;
    if (next.noop === undefined && fromSnap.noop) next.noop = true;
  }
  if (details) next.details = details;
  const changed = next.detail !== cur.detail || next.result !== cur.result || next.noop !== cur.noop || next.review !== cur.review || next.suggestion !== cur.suggestion
    || JSON.stringify(next.details) !== JSON.stringify(cur.details);
  return changed ? next : cur;
}

/** The card's status after one live frame; `undefined` when the frame is not about the card. */
export function statusFromEvent(eventType: string | undefined, p: Record<string, unknown>, prev: PipelineRunStatus | undefined, pipelineId?: string, tables: StepLabelTables = {}): PipelineRunStatus | undefined {
  const type = normalizeEventType(eventType);
  const details = detailsFromEvent(type, p, prev?.details, pipelineId, tables);
  const phase = phaseFromEvent(type, p, prev, pipelineId, tables);
  if (phase) return details ? { ...phase, details } : phase;
  // A frame that says nothing about the phase can still move a step in the timeline.
  if (details && prev && details !== prev.details) return { ...prev, details };
  return undefined;
}

function phaseFromEvent(type: string | undefined, p: Record<string, unknown>, prev: PipelineRunStatus | undefined, pipelineId?: string, tables: StepLabelTables = {}): PipelineRunStatus | undefined {
  const stepId = typeof p.stepId === 'string' ? p.stepId : '';
  switch (type) {
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
      if (stepId === 'apply' || stepId === 'publish' || stepId === 'announce') {
        const outputs = { [stepId]: p.output };
        const suggestion = suggestionOf(outputs, p);
        // The apply step's verdict travels to the completion frame: a skip stays a skip.
        return { phase: 'running', stepLabel: 'Finishing', detail: runStatusDetail(outputs), ...(suggestion ? { suggestion } : {}), ...(isNoop(outputs) ? { noop: true } : {}) };
      }
      return undefined;
    }
    case 'pipeline.run.completed': {
      if (p.status === 'rejected') return { phase: 'rejected', detail: rejectedDetail(p.rejection) };
      // A completion frame that says the run failed IS a failure, whatever the event's name.
      if (p.status === 'failed' || p.status === 'cancelled') return { phase: 'failed', detail: errorMessage(p.error) ?? 'The run failed' };
      const result = resultOf(p as { result?: unknown; output?: unknown }, []);
      const outputs = outputsOfContext(p.output);
      const noop = isNoop(outputs) || (prev?.phase === 'running' && prev.noop === true);
      const base: PipelineRunStatus = {
        phase: 'completed',
        detail: (prev?.phase === 'running' ? prev.detail : undefined) ?? runStatusDetail(outputs) ?? 'Done',
        ...(result !== undefined ? { result } : {}),
        ...(noop ? { noop: true } : {}),
      };
      return withReview(base, suggestionOf(outputs, { ...p, ...((p.output ?? {}) as Record<string, unknown>) }) ?? prev?.suggestion, prev?.review);
    }
    case 'pipeline.run.reviewed': {
      const review = reviewOf(p);
      if (!review) return undefined;
      const documentId = firstString(p.documentId, prev?.suggestion?.documentId);
      const suggestion: PipelineRunSuggestion | undefined = prev?.suggestion
        ? { ...prev.suggestion, ...(documentId ? { documentId } : {}) }
        : (typeof p.suggestionKey === 'string' && p.suggestionKey ? { key: p.suggestionKey, applied: 0, ...(documentId ? { documentId } : {}) } : undefined);
      return withReview({ ...(prev ?? {}), phase: 'completed' }, suggestion, review);
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
export const DEFAULT_REVIEW_POLL_MS = 15_000;

export function usePipelineRunStatus(
  runs: readonly PipelineRunRef[],
  opts: UsePipelineRunStatusOptions,
): (runId: string) => PipelineRunStatus | undefined {
  const { apiBaseUrl, idToken, transport, stepLabels, pipelineStepLabels } = opts;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const reviewPollMs = opts.reviewPollMs ?? DEFAULT_REVIEW_POLL_MS;

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
            const cur = prev[r.runId];
            if (TERMINAL.has(cur?.phase)) {
              // A terminal phase learned from a frame is never walked back by a
              // stale snapshot — but the snapshot fills the card in: a pending
              // suggestion settles, a placeholder line gives way, details land.
              const next = enrichTerminalStatus(cur, snap, r.pipelineId, tablesRef.current);
              return next === cur ? prev : { ...prev, [r.runId]: next };
            }
            const next = statusFromSnapshot(snap, cur, r.pipelineId, tablesRef.current);
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

  // A completed suggestion waits on a person; re-read slowly until the review
  // lands (the `pipeline.run.reviewed` frame is the fast path). Reviewed = settled.
  useEffect(() => {
    if (!idToken || reviewPollMs <= 0) return;
    const awaiting = runs.filter((r) => isAwaitingReview(statuses[r.runId]));
    if (awaiting.length === 0) return;
    const timer = setInterval(() => {
      for (const r of awaiting) fetched.current.delete(r.runId);
      setTick((t) => t + 1);
    }, reviewPollMs);
    return () => clearInterval(timer);
  }, [runs, statuses, idToken, reviewPollMs]);

  return useCallback((runId: string) => statuses[runId], [statuses]);
}

export default usePipelineRunStatus;
