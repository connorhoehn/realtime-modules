// realtime-modules/src/client/pipelines/catalog.ts
//
// The shared vocabulary of the pipelines directory: what kind of work a
// pipeline does (its group on the page), the mark its row wears, the last-run
// rollup platform-api keeps beside each definition, and the pure rules the
// page reads them with — grouping, the status pill, and the merge that keeps
// a rollup current from the run events the gateway already fans out.
//
// This file is the one home of the enum (realtime-examples
// docs/design/pipelines-page/PLAN.md §2.1–2.5). platform-api mirrors the
// values with a contract test; the host re-exports them from here. Everything
// in this file is pure (no React, no fetch) so scripts and tests can use it
// the same way the hook does.

// ---------------------------------------------------------------------------
// §2.1 — definition metadata
// ---------------------------------------------------------------------------

/** The group a pipeline sits under on the page. */
export type WorkType = 'documents' | 'agents' | 'conversations' | 'other';
/** Alias of `WorkType` for hosts that namespace their imports. */
export type PipelineWorkType = WorkType;

export const WORK_TYPE_LABEL: Record<WorkType, string> = {
  documents: 'Documents & presentations',
  agents: 'Agents & experiments',
  conversations: 'Conversations & media',
  other: 'Other',
};

/** The order the groups render in. Empty groups are not rendered. */
export const WORK_TYPE_ORDER: WorkType[] = ['documents', 'agents', 'conversations', 'other'];

/** The row mark. Each kind belongs to exactly one work type (`KIND_WORK_TYPE`). */
export type PipelineKind =
  | 'document' | 'presentation' | 'diagram'          // → workType documents
  | 'agent' | 'experiment'                           // → agents
  | 'recording' | 'call' | 'conversation' | 'media'  // → conversations
  | 'workflow';                                      // → other

export const PIPELINE_KIND_ORDER: readonly PipelineKind[] = [
  'document', 'presentation', 'diagram',
  'agent', 'experiment',
  'recording', 'call', 'conversation', 'media',
  'workflow',
];
/** platform-api's name for the same list. */
export const PIPELINE_KINDS = PIPELINE_KIND_ORDER;

/**
 * The ui-components `FileKindMark` kind for each pipeline kind. Strings, not
 * the library's type: this package does not depend on ui-components, and the
 * host's `FileKind` union accepts every value here.
 */
export const KIND_MARK: Record<PipelineKind, string> = {
  document: 'page', presentation: 'presentation', diagram: 'diagram',
  agent: 'agent', experiment: 'experiment',
  recording: 'recording', call: 'call', conversation: 'conversation', media: 'media',
  workflow: 'workflow',
};

export const KIND_WORK_TYPE: Record<PipelineKind, WorkType> = {
  document: 'documents', presentation: 'documents', diagram: 'documents',
  agent: 'agents', experiment: 'agents',
  recording: 'conversations', call: 'conversations', conversation: 'conversations', media: 'conversations',
  workflow: 'other',
};

export const KIND_LABEL: Record<PipelineKind, string> = {
  document: 'Document', presentation: 'Presentation', diagram: 'Diagram',
  agent: 'Agent', experiment: 'Experiment',
  recording: 'Recording', call: 'Call', conversation: 'Conversation', media: 'Media',
  workflow: 'Workflow',
};

export function isWorkType(v: unknown): v is WorkType {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(WORK_TYPE_LABEL, v);
}

export function isPipelineKind(v: unknown): v is PipelineKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(KIND_MARK, v);
}

/** The definition's own lifecycle — unchanged from the host's `PipelineStatus`. */
export type PipelineDefinitionStatus = 'draft' | 'published' | 'archived';

export type OriginKind = 'system' | 'template' | 'agent' | 'blank' | 'import';
export const ORIGIN_KINDS: readonly OriginKind[] = ['system', 'template', 'agent', 'blank', 'import'];

/** The longest instruction `origin.instruction` and `/generate` accept. */
export const MAX_INSTRUCTION_CHARS = 4000;
/** `route` shows this many steps before the platform folds the rest into "… +N". */
export const MAX_ROUTE_ENTRIES = 6;

/** Where a definition came from (platform-api `DefinitionOrigin`). */
export interface PipelineOrigin {
  kind: OriginKind;
  templateId?: string;
  /** The `/agent` text, verbatim (≤ `MAX_INSTRUCTION_CHARS`). */
  instruction?: string;
  /** `fallback` when the planner was down and a single-step plan stood in — the row says so. */
  plannerSource?: 'model' | 'fallback';
  plannedAt?: string;
}
export type DefinitionOrigin = PipelineOrigin;

/** A field the list route filled in because the stored definition had none. */
export type InferredField = 'workType' | 'kind' | 'route';

/**
 * The fields of a definition the catalog reads. The definition JSON carries
 * more (nodes, edges, trigger binding, …); it rides along untyped so an entry
 * can be handed to the editor without a second fetch.
 */
export interface PipelineCatalogDefinition {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  icon?: string;
  version: number;
  status: PipelineDefinitionStatus;
  publishedVersion?: number;
  /** Group; inferred by the platform when a legacy definition has none. */
  workType?: WorkType;
  /** Row mark; inferred by the platform when absent. */
  kind?: PipelineKind;
  /** Short step labels ("/doc", "Read", "Plan", "Approval", …), explicit or derived by the platform. */
  route?: string[];
  origin?: PipelineOrigin;
  /** Present only when at least one of `workType` / `kind` / `route` was inferred rather than stored. */
  inferred?: InferredField[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// §2.2 — last-run rollup
// ---------------------------------------------------------------------------

/**
 * A run as the rollup sees it: the run-list item statuses plus the
 * platform-only `interrupted` (force-failed after an orphan) and `stuck`
 * (nobody has heard from it). Mirrors platform-api's `RollupRunStatus`.
 */
export type RunItemStatus =
  | 'pending' | 'running' | 'awaiting_approval' | 'paused_at_breakpoint'
  | 'completed' | 'failed' | 'cancelled' | 'rejected'
  | 'interrupted' | 'stuck';
/** Aliases of `RunItemStatus`: platform-api's name, and a namespaced one. */
export type RollupRunStatus = RunItemStatus;
export type PipelineRunItemStatus = RunItemStatus;

export const RUN_ITEM_STATUSES: readonly RunItemStatus[] = [
  'pending', 'running', 'awaiting_approval', 'paused_at_breakpoint',
  'completed', 'failed', 'cancelled', 'rejected',
  'interrupted', 'stuck',
];

/** How many runs a rollup remembers (platform-api `RECENT_LIMIT`). */
export const ROLLUP_RECENT_LIMIT = 5;
export const RECENT_LIMIT = ROLLUP_RECENT_LIMIT;

/** One run in `recent` (platform-api `RollupRecentRun`). */
export interface PipelineRunRollupItem {
  runId: string;
  status: RunItemStatus;
  startedAt: string;
  completedAt?: string;
  /** The event time that set `status` — the per-entry ordering guard. */
  at: string;
}
export type RollupRecentRun = PipelineRunRollupItem;

/**
 * platform-api's `pipeline-run-rollups` row: the newest runs of a pipeline,
 * kept by a subscriber to the run lifecycle events with a conditional write
 * so an older or duplicate event cannot regress it. The client applies the
 * same rule (`applyRunEvent`).
 */
export interface PipelineRunRollup {
  pipelineId: string;
  /** Empty string on the sentinel row of a pipeline that has never run. */
  lastRunId: string;
  /** `startedAt` of the newest run; `''` for the sentinel. */
  lastRunAt: string;
  /** `null` for the sentinel. */
  lastRunStatus: RunItemStatus | null;
  /** Newest first, ≤ `ROLLUP_RECENT_LIMIT`. */
  recent: PipelineRunRollupItem[];
  /** `recent` rows that are failed | interrupted | stuck. */
  failedOfRecent: number;
  /** `recent` rows still pending | running | awaiting_approval | paused_at_breakpoint. */
  runningCount: number;
  /** Distinct runs this row has absorbed (exact while events arrive in order). */
  runCount: number;
  /** The newest event time the row absorbed. */
  updatedAt: string;
}

/** One list entry: the definition, its rollup (`null` until the platform has one), and whether the caller may edit it. */
export type PipelineCatalogEntry = PipelineCatalogDefinition & {
  rollup: PipelineRunRollup | null;
  /** A platform-owned pipeline with no stored override — shown, not editable. */
  readOnly?: boolean;
  /**
   * Runs of this pipeline waiting on a person right now, from the platform's
   * approval queue (`?include=rollup` attaches it). Replica-local today
   * (PLAN §4.9); absent from a platform that predates it.
   */
  pendingApprovals?: number;
};

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const LIVE: ReadonlySet<string> = new Set(['pending', 'running', 'awaiting_approval', 'paused_at_breakpoint']);
const BAD: ReadonlySet<string> = new Set(['failed', 'interrupted', 'stuck']);

/** failed | interrupted | stuck — what `failedOfRecent` counts. */
export function isFailedRunStatus(status: RunItemStatus | null | undefined): boolean {
  return !!status && BAD.has(status);
}

/** pending | running | awaiting_approval | paused_at_breakpoint — what `runningCount` counts. */
export function isActiveRunStatus(status: RunItemStatus | null | undefined): boolean {
  return !!status && LIVE.has(status);
}

/**
 * completed | failed | cancelled | rejected. `interrupted` and `stuck` are
 * NOT terminal: a stuck run may still finish, and the platform applies both
 * as live states a later terminal event can overwrite.
 */
export function isTerminalRunStatus(status: RunItemStatus | null | undefined): boolean {
  return !!status && TERMINAL.has(status);
}

// ---------------------------------------------------------------------------
// The row view
// ---------------------------------------------------------------------------

/**
 * What a row on the page needs, flattened: the definition's identity and
 * metadata with the rollup's counts beside it. Built with `summarize`.
 */
export interface PipelineDefinitionSummary {
  id: string;
  name: string;
  description?: string;
  workType: WorkType;
  kind: PipelineKind;
  /** `KIND_MARK[kind]`. */
  mark: string;
  route: string[];
  origin?: PipelineOrigin;
  status: PipelineDefinitionStatus;
  readOnly: boolean;
  tags?: string[];
  updatedAt: string;
  lastRunId?: string;
  lastRunAt?: string;
  lastRunStatus?: RunItemStatus;
  /** Failed | interrupted | stuck among the recent runs. */
  failedCount: number;
  /** How many recent runs the rollup holds (0 when the pipeline never ran). */
  totalCount: number;
  /** Runs waiting on a person: the platform's live count when the entry carries one, else the recent runs in `awaiting_approval`. */
  pendingApprovals: number;
  /** Recent runs still running or awaiting approval. */
  runningCount: number;
  /** True while the platform has not produced a rollup for this entry yet. */
  rollupPending: boolean;
}

/** Work type of an entry: the explicit field, else the kind's, else 'other'. */
export function workTypeOf(def: Pick<PipelineCatalogDefinition, 'workType' | 'kind'>): WorkType {
  if (isWorkType(def.workType)) return def.workType;
  if (isPipelineKind(def.kind)) return KIND_WORK_TYPE[def.kind];
  return 'other';
}

/** Kind of an entry: the explicit field, else 'workflow'. */
export function kindOf(def: Pick<PipelineCatalogDefinition, 'kind'>): PipelineKind {
  return isPipelineKind(def.kind) ? def.kind : 'workflow';
}

export function summarize(entry: PipelineCatalogEntry): PipelineDefinitionSummary {
  const rollup = entry.rollup ?? null;
  const recent = rollup?.recent ?? [];
  const kind = kindOf(entry);
  const hasRun = !!rollup && !!rollup.lastRunId;
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    workType: workTypeOf(entry),
    kind,
    mark: KIND_MARK[kind],
    route: Array.isArray(entry.route) ? entry.route.filter((s): s is string => typeof s === 'string') : [],
    origin: entry.origin,
    status: entry.status,
    readOnly: entry.readOnly === true,
    tags: entry.tags,
    updatedAt: entry.updatedAt,
    lastRunId: hasRun ? rollup!.lastRunId : undefined,
    lastRunAt: hasRun ? rollup!.lastRunAt : undefined,
    lastRunStatus: hasRun ? rollup!.lastRunStatus ?? undefined : undefined,
    failedCount: rollup ? rollup.failedOfRecent : 0,
    totalCount: recent.length,
    pendingApprovals: typeof entry.pendingApprovals === 'number'
      ? entry.pendingApprovals
      : recent.filter((r) => r.status === 'awaiting_approval').length,
    runningCount: rollup ? rollup.runningCount : 0,
    rollupPending: rollup === null,
  };
}

export function summarizeAll(entries: readonly PipelineCatalogEntry[]): PipelineDefinitionSummary[] {
  return entries.map(summarize);
}

// ---------------------------------------------------------------------------
// Grouping and ordering
// ---------------------------------------------------------------------------

export type CatalogGroupBy = 'workType' | 'kind' | 'status';

export interface PipelineCatalogGroupCounts {
  total: number;
  failed: number;
  running: number;
  pendingApprovals: number;
}

export interface PipelineCatalogGroup {
  /** The group key: a `WorkType`, `PipelineKind` or `PipelineDefinitionStatus` depending on `by`. */
  key: string;
  label: string;
  /** Set when grouped by work type. */
  workType?: WorkType;
  entries: PipelineDefinitionSummary[];
  counts: PipelineCatalogGroupCounts;
}

const DEFINITION_STATUS_ORDER: PipelineDefinitionStatus[] = ['published', 'draft', 'archived'];
const DEFINITION_STATUS_LABEL: Record<PipelineDefinitionStatus, string> = {
  published: 'Published', draft: 'Draft', archived: 'Archived',
};

function timeOf(iso: string | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Row order inside a group: something in flight first, then by most recent
 * run, then by most recently edited, then by name so the order is total.
 */
export function compareSummaries(a: PipelineDefinitionSummary, b: PipelineDefinitionSummary): number {
  const aActive = isActiveRunStatus(a.lastRunStatus) ? 1 : 0;
  const bActive = isActiveRunStatus(b.lastRunStatus) ? 1 : 0;
  if (aActive !== bActive) return bActive - aActive;
  const byRun = timeOf(b.lastRunAt) - timeOf(a.lastRunAt);
  if (byRun !== 0) return byRun;
  const byEdit = timeOf(b.updatedAt) - timeOf(a.updatedAt);
  if (byEdit !== 0) return byEdit;
  return a.name.localeCompare(b.name);
}

export function sortSummaries(summaries: readonly PipelineDefinitionSummary[]): PipelineDefinitionSummary[] {
  return [...summaries].sort(compareSummaries);
}

function countsOf(entries: readonly PipelineDefinitionSummary[]): PipelineCatalogGroupCounts {
  let failed = 0; let running = 0; let pendingApprovals = 0;
  for (const e of entries) {
    if (isFailedRunStatus(e.lastRunStatus) || e.failedCount > 0) failed += 1;
    if (e.runningCount > 0 || isActiveRunStatus(e.lastRunStatus)) running += 1;
    pendingApprovals += e.pendingApprovals;
  }
  return { total: entries.length, failed, running, pendingApprovals };
}

/**
 * Group summaries for the page. Groups follow the enum's order, empty groups
 * are omitted, and the rows inside each are sorted by `compareSummaries`.
 */
export function groupCatalog(
  summaries: readonly PipelineDefinitionSummary[],
  by: CatalogGroupBy = 'workType',
): PipelineCatalogGroup[] {
  const order: readonly string[] =
    by === 'workType' ? WORK_TYPE_ORDER : by === 'kind' ? PIPELINE_KIND_ORDER : DEFINITION_STATUS_ORDER;
  const labelOf = (k: string): string =>
    by === 'workType' ? WORK_TYPE_LABEL[k as WorkType]
      : by === 'kind' ? KIND_LABEL[k as PipelineKind]
        : DEFINITION_STATUS_LABEL[k as PipelineDefinitionStatus] ?? k;
  const keyOf = (s: PipelineDefinitionSummary): string =>
    by === 'workType' ? s.workType : by === 'kind' ? s.kind : s.status;

  const buckets = new Map<string, PipelineDefinitionSummary[]>();
  for (const s of summaries) {
    const k = keyOf(s);
    const list = buckets.get(k);
    if (list) list.push(s); else buckets.set(k, [s]);
  }
  const keys = [...order.filter((k) => buckets.has(k)), ...[...buckets.keys()].filter((k) => !order.includes(k))];
  return keys.map((key) => {
    const entries = sortSummaries(buckets.get(key)!);
    return {
      key,
      label: labelOf(key),
      ...(by === 'workType' ? { workType: key as WorkType } : {}),
      entries,
      counts: countsOf(entries),
    };
  });
}

/** `groupCatalog(summaries, 'workType')` — the page's default. */
export function groupByWorkType(summaries: readonly PipelineDefinitionSummary[]): PipelineCatalogGroup[] {
  return groupCatalog(summaries, 'workType');
}

// ---------------------------------------------------------------------------
// The status pill
// ---------------------------------------------------------------------------

export type PipelineStatusPillTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface PipelineStatusPill {
  tone: PipelineStatusPillTone;
  /** "Published", "1 of 5 failed", "Failed", "Running", "Draft". */
  label: string;
  /** The relative time of the last run when the pill is about a run ("29m ago"); absent for a definition-only pill. */
  meta?: string;
  /** `label` and `meta` joined the way the row reads them: "1 of 5 failed · 29m ago". */
  text: string;
}

/**
 * "just now" / "3m ago" / "2h ago" / "2d ago" / a plain date past three days.
 * The same shape the host's `formatTime.ts` produces, so the list and the run
 * pages agree about the same run. `now` is injectable for tests.
 */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '--';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '--';
  const d = now - then;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  if (d < 259_200_000) return `${Math.floor(d / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function pill(tone: PipelineStatusPillTone, label: string, meta?: string): PipelineStatusPill {
  return { tone, label, ...(meta ? { meta } : {}), text: meta ? `${label} · ${meta}` : label };
}

/**
 * The pill for a row (PLAN §2.2): a run in flight → info; the newest run
 * failed → danger "Failed · 10h ago"; some of the recent runs failed →
 * warning "1 of 5 failed · 29m ago"; otherwise the definition's own status.
 */
export function statusPillFor(summary: PipelineDefinitionSummary, now: number = Date.now()): PipelineStatusPill {
  const rel = summary.lastRunAt ? relativeTime(summary.lastRunAt, now) : undefined;
  const last = summary.lastRunStatus;
  if (last === 'running') return pill('info', 'Running', rel);
  if (last === 'pending') return pill('info', 'Queued', rel);
  if (last === 'awaiting_approval') return pill('info', 'Awaiting approval', rel);
  if (last === 'paused_at_breakpoint') return pill('info', 'Paused', rel);
  if (last === 'failed') return pill('danger', 'Failed', rel);
  if (last === 'interrupted') return pill('danger', 'Interrupted', rel);
  if (last === 'stuck') return pill('warning', 'Stuck', rel);
  if (summary.failedCount > 0 && summary.totalCount > 0) {
    return pill('warning', `${summary.failedCount} of ${summary.totalCount} failed`, rel);
  }
  if (summary.status === 'published') return pill('success', 'Published');
  if (summary.status === 'archived') return pill('neutral', 'Archived');
  return pill('neutral', 'Draft');
}

// ---------------------------------------------------------------------------
// Rollup merge — the client half of the run-rollup subscriber
// ---------------------------------------------------------------------------

/**
 * One run lifecycle event, as the merge sees it (platform-api
 * `RunRollupEvent`). Built from a wire frame by `runEventFromFrame`.
 */
export interface RunRollupEvent {
  pipelineId: string;
  runId: string;
  status: RunItemStatus;
  /** ISO time the event happened; orders events per run and stamps `updatedAt`. */
  at: string;
  /** For a run first seen by a later event: when it started, if the payload said. */
  startedAt?: string;
  /** The terminal stamp when the payload carried one; else `at` is used. */
  completedAt?: string;
}
export type PipelineRunLifecycleEvent = RunRollupEvent;

/**
 * Event type → the run status it puts a run in — the same table the
 * platform's subscriber applies. Both the dotted and the colon-separated
 * spellings are accepted by `runEventFromFrame`. A `completed` whose payload
 * says `status: 'rejected'` is a rejection.
 */
export const RUN_EVENT_STATUS: Record<string, RunItemStatus> = {
  'pipeline.run.started': 'running',
  'pipeline.run.resumed': 'running',
  'pipeline.run.completed': 'completed',
  'pipeline.run.failed': 'failed',
  'pipeline.run.cancelled': 'cancelled',
  'pipeline.run.orphaned': 'interrupted',
  'pipeline.run.stuck': 'stuck',
};

const EVENT_TIME_FIELDS = ['at', 'startedAt', 'completedAt', 'failedAt', 'cancelledAt', 'stuckAt', 'interruptedAt', 'timestamp'];

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Parse a gateway `pipeline:event` frame into a rollup event, or `undefined`
 * when the frame is not one (a step, a token, a checkpoint, an approval …) or
 * names no pipeline. The event time is the payload's `at` (or its own stamp)
 * when it carries one, else the envelope's `emittedAt`, else `now`.
 */
export function runEventFromFrame(frame: unknown, now: () => string = () => new Date().toISOString()): RunRollupEvent | undefined {
  if (!frame || typeof frame !== 'object') return undefined;
  const msg = frame as { type?: unknown; eventType?: unknown; payload?: unknown; emittedAt?: unknown };
  if (msg.type !== 'pipeline:event') return undefined;
  const type = typeof msg.eventType === 'string' ? msg.eventType.replace(/:/g, '.') : '';
  let status = RUN_EVENT_STATUS[type];
  if (!status) return undefined;
  const p = (msg.payload && typeof msg.payload === 'object' ? msg.payload : {}) as Record<string, unknown>;
  const runId = str(p.runId);
  const pipelineId = str(p.pipelineId);
  if (!runId || !pipelineId) return undefined;
  if (type === 'pipeline.run.completed' && p.status === 'rejected') status = 'rejected';
  let at: string | undefined;
  for (const f of EVENT_TIME_FIELDS) { at = str(p[f]); if (at) break; }
  at = at ?? str(msg.emittedAt) ?? now();
  const startedAt = type === 'pipeline.run.started' ? str(p.startedAt) ?? at : str(p.startedAt);
  const completedAt = isTerminalRunStatus(status) ? str(p.completedAt) ?? str(p.failedAt) ?? str(p.cancelledAt) : undefined;
  return {
    pipelineId, runId, status, at,
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
  };
}

function byStartedAtDesc(a: PipelineRunRollupItem, b: PipelineRunRollupItem): number {
  if (a.startedAt === b.startedAt) return a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0;
  return a.startedAt < b.startedAt ? 1 : -1;
}

function maxIso(a: string, b: string): string { return a > b ? a : b; }

function derive(pipelineId: string, recent: PipelineRunRollupItem[], runCount: number, updatedAt: string): PipelineRunRollup {
  const sorted = [...recent].sort(byStartedAtDesc).slice(0, ROLLUP_RECENT_LIMIT);
  const newest = sorted[0];
  return {
    pipelineId,
    lastRunId: newest?.runId ?? '',
    lastRunAt: newest?.startedAt ?? '',
    lastRunStatus: newest?.status ?? null,
    recent: sorted,
    failedOfRecent: sorted.filter((r) => BAD.has(r.status)).length,
    runningCount: sorted.filter((r) => LIVE.has(r.status)).length,
    runCount,
    updatedAt,
  };
}

/** The row a pipeline gets before any run: nothing recent (the platform's sentinel). */
export function emptyRollup(pipelineId: string, at: string): PipelineRunRollup {
  return derive(pipelineId, [], 0, at);
}

/**
 * Apply one lifecycle event to a rollup — the rule platform-api's subscriber
 * applies before its conditional put, ported line for line so the browser's
 * copy and the row converge:
 *
 * - a run already in `recent`: an event older than the entry's own `at`, a
 *   replay (same status), or a non-terminal event for a finished run changes
 *   nothing (terminal is final); otherwise the entry takes the new status;
 * - a run not yet in `recent` is appended — unless the window is full and the
 *   run started before everything kept, which is history and must not evict
 *   a newer run;
 * - `recent` stays newest-first, capped at 5; `lastRun*`, `failedOfRecent`,
 *   `runningCount` are recomputed; `runCount` counts distinct runs absorbed.
 *
 * Returns the SAME object when nothing changed, so a caller can skip a render.
 * ISO-8601 UTC strings compare as strings, exactly as the platform compares them.
 */
export function applyRunEvent(existing: PipelineRunRollup | null, event: RunRollupEvent): PipelineRunRollup {
  const base = existing ?? emptyRollup(event.pipelineId, event.at);
  if (base.pipelineId !== event.pipelineId) return base;
  const idx = base.recent.findIndex((r) => r.runId === event.runId);
  const recent = base.recent.slice();
  let runCount = base.runCount;

  if (idx >= 0) {
    const cur = recent[idx];
    const older = event.at < cur.at;
    const regress = TERMINAL.has(cur.status) && !TERMINAL.has(event.status);
    const same = cur.status === event.status && !(event.completedAt && !cur.completedAt);
    if (older || regress || same) {
      // Nothing new — but a started event can still fill a missing startedAt.
      if (event.startedAt && cur.startedAt === cur.at && event.startedAt < cur.startedAt) {
        recent[idx] = { ...cur, startedAt: event.startedAt };
        return derive(base.pipelineId, recent, runCount, maxIso(base.updatedAt, event.at));
      }
      return existing ?? base;
    }
    recent[idx] = {
      ...cur,
      status: event.status,
      at: event.at,
      ...(event.startedAt && event.startedAt < cur.startedAt ? { startedAt: event.startedAt } : {}),
      ...(event.completedAt ? { completedAt: event.completedAt } : TERMINAL.has(event.status) ? { completedAt: event.at } : {}),
    };
  } else {
    const startedAt = event.startedAt ?? event.at;
    if (recent.length >= ROLLUP_RECENT_LIMIT && startedAt < recent[recent.length - 1].startedAt) {
      return existing ?? base;
    }
    recent.push({
      runId: event.runId,
      status: event.status,
      startedAt,
      at: event.at,
      ...(event.completedAt ? { completedAt: event.completedAt } : TERMINAL.has(event.status) ? { completedAt: event.at } : {}),
    });
    runCount += 1;
  }
  return derive(base.pipelineId, recent, runCount, maxIso(base.updatedAt, event.at));
}

/**
 * Apply an event to the entry it names. Entries that are not the event's
 * pipeline keep their identity; an event for a pipeline not in the list is
 * ignored (the definition list is refreshed by the caller, not invented here).
 * Returns the SAME array when nothing changed.
 */
export function mergeRunEvent(entries: readonly PipelineCatalogEntry[], event: RunRollupEvent): readonly PipelineCatalogEntry[] {
  let changed = false;
  const out = entries.map((e) => {
    if (e.id !== event.pipelineId) return e;
    const rollup = applyRunEvent(e.rollup, event);
    if (rollup === e.rollup) return e;
    changed = true;
    return { ...e, rollup };
  });
  return changed ? out : entries;
}
