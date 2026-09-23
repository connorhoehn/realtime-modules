// realtime-modules/src/client/documents/work.ts
//
// The Documents four-pane redesign's data, as the browser reads it
// (realtime-examples `docs/design/documents-detail/PLAN.md` §2). platform-api
// owns the rows; this file mirrors their field names exactly, and holds the
// pure pieces the hooks are built from — REST helpers usable from scripts,
// the optimistic-apply rule for a work PATCH, the Work column's grouping, and
// the parser for the gateway's id-only `doc-work:*` signals.
//
// Signals carry ids and enums only (the gateway authorizes the subscription,
// but anything textual is re-read over REST behind the document grant). So a
// hook never trusts a frame's content beyond "this record changed at revision
// n": it refetches the one record.

// ---------------------------------------------------------------------------
// §2.1 Work fields on a document
// ---------------------------------------------------------------------------

export type WorkStatus = 'next' | 'in_progress' | 'in_review' | 'done';
export type WorkPriority = 'low' | 'medium' | 'high' | 'urgent';
export type WorkLinkRelation = 'depends-on' | 'decided-by';
/** The scalar fields a PATCH `set` may carry and `fieldRevisions` versions. */
export type WorkScalarField = 'status' | 'points' | 'ownerId' | 'priority' | 'rank' | 'outcome';

export interface WorkCriterion {
  text: string;
  done: boolean;
  rank: string;
  doneBy?: string;
  doneAt?: string;
}

export interface WorkLink {
  documentId: string;
  relation: WorkLinkRelation;
}

export interface DocumentWork {
  documentId: string;
  organizationId: string;
  /** Absent = "Not planned". */
  status?: WorkStatus;
  /** 0..100, integer. */
  points?: number;
  /** Absent in storage → the lifecycle owner, filled on read. */
  ownerId?: string;
  priority?: WorkPriority;
  /** Fractional index within its status group. */
  rank?: string;
  /** ≤ 2000 chars, plain text. */
  outcome?: string;
  criteria: Record<string, WorkCriterion>;
  links: Record<string, WorkLink>;
  fieldRevisions: Partial<Record<WorkScalarField, number>>;
  /** CAS version, +1 per applied write; 0 for a row backfilled on read. */
  revision: number;
  updatedAt: string;
  updatedBy: string;
  /** The Work-column scope the row belongs to (a parent document id, or `type:<type>`). */
  scopeId?: string;
  /** False for a row the platform backfilled on read (nothing stored yet). */
  tracked?: boolean;
}

/** One criterion operation, keyed by a client-made id so a retried op is a no-op. */
export type WorkCriterionOp =
  | { op: 'add'; id: string; text: string; rank?: string }
  | { op: 'check'; id: string; done: boolean }
  | { op: 'edit'; id: string; text: string }
  | { op: 'remove'; id: string }
  | { op: 'move'; id: string; rank: string };

/** One link operation, keyed by a client-made id. */
export type WorkLinkOp =
  | { op: 'add'; id: string; documentId: string; relation: WorkLinkRelation }
  | { op: 'edit'; id: string; relation: WorkLinkRelation }
  | { op: 'remove'; id: string };

/** Scalars a PATCH may set; `null` clears a field (back to "Not planned", "Unassigned", …). */
export type WorkScalarSet = {
  status?: WorkStatus | null;
  points?: number | null;
  ownerId?: string | null;
  priority?: WorkPriority | null;
  rank?: string | null;
  outcome?: string | null;
  /** A move in the explorer re-homes the row (§2.1). */
  scopeId?: string | null;
};

/** What `useDocumentWork().update` takes: the PATCH body without `expectedRevision`. */
export interface WorkUpdate {
  set?: WorkScalarSet;
  criteria?: WorkCriterionOp[];
  links?: WorkLinkOp[];
}

export interface WorkPatchBody extends WorkUpdate {
  expectedRevision: number;
}

/** A client-made id for a criterion, a link or a run draft: ≤ 64, `[A-Za-z0-9_-]`. */
export function newWorkItemId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${hex()}-${hex()}${hex()}${hex()}`;
}

/** A rank strictly after `last` (or the first one) — enough for appending; drag order is the host's. */
export function rankAfter(last?: string): string {
  return last ? `${last}n` : 'n';
}

/**
 * The optimistic view of a PATCH: what the row looks like if the platform
 * applies it. Pure, and forgiving the way the server is — a check on a
 * criterion that no longer exists changes nothing.
 */
export function applyWorkUpdate(work: DocumentWork, update: WorkUpdate): DocumentWork {
  const next: DocumentWork = { ...work, criteria: { ...work.criteria }, links: { ...work.links } };
  const set = update.set ?? {};
  for (const key of Object.keys(set) as Array<keyof WorkScalarSet>) {
    const value = set[key];
    if (value === undefined) continue;
    if (value === null) delete (next as unknown as Record<string, unknown>)[key];
    else (next as unknown as Record<string, unknown>)[key] = value;
  }
  for (const op of update.criteria ?? []) {
    const cur = next.criteria[op.id];
    switch (op.op) {
      case 'add': {
        if (cur) break;
        const ranks = Object.values(next.criteria).map((c) => c.rank).sort();
        next.criteria[op.id] = { text: op.text, done: false, rank: op.rank ?? rankAfter(ranks[ranks.length - 1]) };
        break;
      }
      case 'check': if (cur) next.criteria[op.id] = { ...cur, done: op.done }; break;
      case 'edit': if (cur) next.criteria[op.id] = { ...cur, text: op.text }; break;
      case 'move': if (cur) next.criteria[op.id] = { ...cur, rank: op.rank }; break;
      case 'remove': delete next.criteria[op.id]; break;
    }
  }
  for (const op of update.links ?? []) {
    const cur = next.links[op.id];
    switch (op.op) {
      case 'add': if (!cur) next.links[op.id] = { documentId: op.documentId, relation: op.relation }; break;
      case 'edit': if (cur) next.links[op.id] = { ...cur, relation: op.relation }; break;
      case 'remove': delete next.links[op.id]; break;
    }
  }
  return next;
}

/** The criteria in display order (by `rank`, then id). */
export function orderedCriteria(work: Pick<DocumentWork, 'criteria'>): Array<WorkCriterion & { id: string }> {
  return Object.entries(work.criteria)
    .map(([id, c]) => ({ id, ...c }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1));
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A platform row (or `{ work }` envelope) in the shape above, with maps defaulted. */
export function normalizeDocumentWork(raw: unknown, documentId?: string): DocumentWork {
  const outer = obj(raw);
  const r = outer.work && typeof outer.work === 'object' ? obj(outer.work) : outer;
  const work = {
    ...r,
    documentId: str(r.documentId) ?? documentId ?? '',
    organizationId: str(r.organizationId) ?? '',
    criteria: obj(r.criteria) as Record<string, WorkCriterion>,
    links: obj(r.links) as Record<string, WorkLink>,
    fieldRevisions: obj(r.fieldRevisions) as DocumentWork['fieldRevisions'],
    revision: num(r.revision) ?? 0,
    updatedAt: str(r.updatedAt) ?? '',
    updatedBy: str(r.updatedBy) ?? '',
  } as DocumentWork;
  if (typeof outer.tracked === 'boolean' && typeof r.tracked !== 'boolean') work.tracked = outer.tracked;
  if (typeof work.tracked !== 'boolean') work.tracked = work.revision > 0;
  return work;
}

// ---------------------------------------------------------------------------
// §2.1 The Work column list
// ---------------------------------------------------------------------------

/** A dispatched run draft's live run, joined to its pipeline's rollup (§2.2). */
export interface WorkActiveRun {
  runId: string;
  pipelineId: string;
  draftId?: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

/** A list row: the work row (backfilled when absent) plus the lifecycle status and live run. */
export interface WorkListRow extends DocumentWork {
  /** The document's lifecycle status (`in_review`, `changes_requested`, `approved`, …), for "Awaiting review". */
  lifecycleStatus?: string;
  activeRun?: WorkActiveRun | null;
}

/** The scope header rollup. `spentUsd` is absent when no linked run exists. */
export interface WorkRollup {
  pointsDone: number;
  pointsTotal: number;
  spentUsd?: number;
  decisions: number;
  agents: number;
}

export interface WorkListResponse {
  scope: string;
  rows: WorkListRow[];
  rollup: WorkRollup;
}

export type WorkGroupKey = WorkStatus | 'not_planned';

export const WORK_STATUS_LABEL: Record<WorkGroupKey, string> = {
  next: 'Next up',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  not_planned: 'Not planned',
};

/** Group order in the Work column. Untracked rows sit under "Not planned", never "Next up". */
export const WORK_GROUP_ORDER: readonly WorkGroupKey[] = ['next', 'in_progress', 'in_review', 'done', 'not_planned'];

export interface WorkGroup {
  key: WorkGroupKey;
  label: string;
  count: number;
  rows: WorkListRow[];
}

export function workGroupOf(row: Pick<DocumentWork, 'status'>): WorkGroupKey {
  return row.status && row.status in WORK_STATUS_LABEL ? row.status : 'not_planned';
}

function byRank(a: WorkListRow, b: WorkListRow): number {
  const ra = a.rank ?? '￿';
  const rb = b.rank ?? '￿';
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0;
}

/** Rows grouped by work status, in `WORK_GROUP_ORDER`, each sorted by `rank`. Empty groups are left out unless asked for. */
export function groupWorkRows(rows: readonly WorkListRow[], opts: { includeEmpty?: boolean } = {}): WorkGroup[] {
  const buckets = new Map<WorkGroupKey, WorkListRow[]>(WORK_GROUP_ORDER.map((k) => [k, []]));
  for (const row of rows) buckets.get(workGroupOf(row))!.push(row);
  return WORK_GROUP_ORDER
    .map((key) => {
      const list = buckets.get(key)!.sort(byRank);
      return { key, label: WORK_STATUS_LABEL[key], count: list.length, rows: list };
    })
    .filter((g) => opts.includeEmpty || g.count > 0);
}

/** Σ points of `done` rows out of Σ over all rows — what the header reads, recomputed after a live merge. */
export function pointsRollup(rows: readonly WorkListRow[]): Pick<WorkRollup, 'pointsDone' | 'pointsTotal'> {
  let pointsDone = 0;
  let pointsTotal = 0;
  for (const row of rows) {
    const p = typeof row.points === 'number' ? row.points : 0;
    pointsTotal += p;
    if (row.status === 'done') pointsDone += p;
  }
  return { pointsDone, pointsTotal };
}

export function normalizeWorkList(raw: unknown, scope: string): WorkListResponse {
  const body = obj(raw);
  const list = Array.isArray(body.rows) ? body.rows : Array.isArray(body.items) ? body.items : [];
  const rows: WorkListRow[] = list
    .filter((r) => r && typeof r === 'object' && typeof (r as { documentId?: unknown }).documentId === 'string')
    .map((r) => {
      const row = normalizeDocumentWork(r) as WorkListRow;
      const active = obj((r as { activeRun?: unknown }).activeRun);
      row.activeRun = str(active.runId) && str(active.pipelineId) ? (active as unknown as WorkActiveRun) : null;
      return row;
    });
  const r = obj(body.rollup);
  const points = pointsRollup(rows);
  const rollup: WorkRollup = {
    pointsDone: num(r.pointsDone) ?? points.pointsDone,
    pointsTotal: num(r.pointsTotal) ?? points.pointsTotal,
    decisions: num(r.decisions) ?? 0,
    agents: num(r.agents) ?? 0,
  };
  const spent = num(r.spentUsd);
  if (spent !== undefined) rollup.spentUsd = spent;
  return { scope: str(body.scope) ?? scope, rows, rollup };
}

/** Merge a re-read work record into its list row, keeping the list-only fields (lifecycle status, live run). */
export function mergeWorkIntoRow(row: WorkListRow | undefined, work: DocumentWork): WorkListRow {
  return { ...(row ?? { activeRun: null }), ...work };
}

// ---------------------------------------------------------------------------
// §2.2 Run drafts
// ---------------------------------------------------------------------------

export type RunDraftModel = 'haiku' | 'sonnet' | 'opus';
export type RunDraftStatus = 'draft' | 'dispatching' | 'dispatched' | 'cancelled';
export type RunDraftSourceKind = 'document' | 'transcript' | 'recording';

export interface RunDraft {
  documentId: string;
  /** = the client requestId (≤ 64, `[A-Za-z0-9_-]`). */
  draftId: string;
  organizationId: string;
  createdBy: string;
  pipelineId: string;
  /** ≤ 4000. */
  instruction: string;
  model?: RunDraftModel;
  contextBudgetTokens?: number;
  hints?: string[];
  sources?: Array<{ kind: RunDraftSourceKind; id: string }>;
  status: RunDraftStatus;
  runId?: string;
  dispatchedAt?: string;
  dispatchedBy?: string;
  revision: number;
  updatedAt: string;
}

/** The PUT body: the editable fields. `pipelineId: null` + `generate: true` asks the planner for one. */
export interface RunDraftInput {
  pipelineId: string | null;
  instruction: string;
  model?: RunDraftModel;
  contextBudgetTokens?: number;
  hints?: string[];
  sources?: Array<{ kind: RunDraftSourceKind; id: string }>;
  generate?: boolean;
}

export interface RunDraftPutBody extends RunDraftInput {
  /** Needed when the body differs from the stored draft (409 otherwise). */
  expectedRevision?: number;
}

/** A draft stuck in `dispatching` this long reads as "Dispatch not confirmed — Retry" (§2.2). */
export const RUN_DRAFT_DISPATCH_STALE_MS = 60_000;

export type RunDraftPhase = 'none' | 'draft' | 'dispatching' | 'unconfirmed' | 'dispatched' | 'cancelled';

/** What the Run draft pane says about a draft. */
export function runDraftPhase(draft: RunDraft | null | undefined, now: number = Date.now()): RunDraftPhase {
  if (!draft) return 'none';
  if (draft.status === 'dispatching') {
    const at = Date.parse(draft.updatedAt);
    return Number.isFinite(at) && now - at > RUN_DRAFT_DISPATCH_STALE_MS ? 'unconfirmed' : 'dispatching';
  }
  return draft.status;
}

export function normalizeRunDraft(raw: unknown): RunDraft | null {
  const outer = obj(raw);
  const r = outer.draft && typeof outer.draft === 'object' ? obj(outer.draft) : outer;
  if (!str(r.draftId) || !str(r.documentId)) return null;
  return { ...r, revision: num(r.revision) ?? 0, status: (str(r.status) ?? 'draft') as RunDraftStatus } as RunDraft;
}

/** The draft the pane shows: the newest one not cancelled, else the newest. */
export function currentRunDraft(drafts: readonly RunDraft[]): RunDraft | null {
  if (drafts.length === 0) return null;
  const sorted = [...drafts].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return sorted.find((d) => d.status !== 'cancelled') ?? sorted[0];
}

// ---------------------------------------------------------------------------
// §2.3 Estimates
// ---------------------------------------------------------------------------

export type RunEstimateConfidence = 'none' | 'low' | 'medium';

export interface RunEstimate {
  pipelineId: string;
  basis: { runs: number; model?: string; repriced: boolean };
  costUsd: { low: number; high: number } | null;
  durationMs: { low: number; high: number } | null;
  confidence: RunEstimateConfidence;
}

/** `null` means "No prior runs": the UI shows no number (a range is never shown with n = 0). */
export function normalizeRunEstimate(raw: unknown): RunEstimate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = obj(raw);
  const basis = obj(r.basis);
  const runs = num(basis.runs) ?? 0;
  if (runs <= 0 || r.confidence === 'none') return null;
  const range = (v: unknown) => {
    const o = obj(v);
    const low = num(o.low);
    const high = num(o.high);
    return low !== undefined && high !== undefined ? { low, high } : null;
  };
  const costUsd = range(r.costUsd);
  const durationMs = range(r.durationMs);
  if (!costUsd && !durationMs) return null;
  return {
    pipelineId: str(r.pipelineId) ?? '',
    basis: { runs, ...(str(basis.model) ? { model: str(basis.model) } : {}), repriced: basis.repriced === true },
    costUsd,
    durationMs,
    confidence: r.confidence === 'medium' ? 'medium' : 'low',
  };
}

// ---------------------------------------------------------------------------
// REST helpers (pure — no React)
// ---------------------------------------------------------------------------

/** The error a documents-work request throws: the server's message, the HTTP status and, when sent, its code and body. */
export type DocumentWorkRequestError = Error & { status: number; code?: string; body?: Record<string, unknown> };

async function errorFrom(res: Response, fallback: string): Promise<DocumentWorkRequestError> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const message = str(body.message) || str(body.error) || `${fallback} (${res.status})`;
  return Object.assign(new Error(message), {
    status: res.status,
    ...(str(body.code) || str(body.error) ? { code: str(body.code) ?? str(body.error) } : {}),
    body,
  });
}

function headers(idToken: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return { ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}), ...extra };
}

const enc = encodeURIComponent;

/** `GET /api/documents/:documentId/work` — backfilled on read when absent (`tracked: false`, revision 0). */
export async function fetchDocumentWork(
  apiBaseUrl: string, idToken: string | null, documentId: string, init?: { signal?: AbortSignal },
): Promise<DocumentWork> {
  const res = await fetch(`${apiBaseUrl}/api/documents/${enc(documentId)}/work`, {
    headers: headers(idToken), ...(init?.signal ? { signal: init.signal } : {}),
  });
  if (!res.ok) throw await errorFrom(res, 'Could not read the work item');
  return normalizeDocumentWork(await res.json(), documentId);
}

/**
 * `PATCH /api/documents/:documentId/work`. A 409 (a field this PATCH changes
 * moved on since `expectedRevision`) throws with `status: 409`.
 */
export async function patchDocumentWork(
  apiBaseUrl: string, idToken: string | null, documentId: string, body: WorkPatchBody,
): Promise<DocumentWork> {
  const res = await fetch(`${apiBaseUrl}/api/documents/${enc(documentId)}/work`, {
    method: 'PATCH',
    headers: headers(idToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res, 'Could not save the work item');
  return normalizeDocumentWork(await res.json(), documentId);
}

/** `GET /api/document-work?scope=<parentId|type:<type>>` — the Work column. */
export async function fetchWorkList(
  apiBaseUrl: string, idToken: string | null, scope: string, init?: { signal?: AbortSignal },
): Promise<WorkListResponse> {
  const res = await fetch(`${apiBaseUrl}/api/document-work?scope=${enc(scope)}`, {
    headers: headers(idToken), ...(init?.signal ? { signal: init.signal } : {}),
  });
  if (!res.ok) throw await errorFrom(res, 'Could not read the work list');
  return normalizeWorkList(await res.json(), scope);
}

/** `GET /api/documents/:documentId/run-drafts` — the document's drafts, newest state of each. */
export async function fetchRunDrafts(
  apiBaseUrl: string, idToken: string | null, documentId: string, init?: { signal?: AbortSignal },
): Promise<RunDraft[]> {
  const res = await fetch(`${apiBaseUrl}/api/documents/${enc(documentId)}/run-drafts`, {
    headers: headers(idToken), ...(init?.signal ? { signal: init.signal } : {}),
  });
  if (!res.ok) throw await errorFrom(res, 'Could not read the run drafts');
  const body = obj(await res.json());
  const list = Array.isArray(body.drafts) ? body.drafts : Array.isArray(body.items) ? body.items : [];
  return list.map(normalizeRunDraft).filter((d): d is RunDraft => d !== null);
}

/** `GET /api/documents/:documentId/run-drafts/:draftId`. */
export async function fetchRunDraft(
  apiBaseUrl: string, idToken: string | null, documentId: string, draftId: string, init?: { signal?: AbortSignal },
): Promise<RunDraft> {
  const res = await fetch(`${apiBaseUrl}/api/documents/${enc(documentId)}/run-drafts/${enc(draftId)}`, {
    headers: headers(idToken), ...(init?.signal ? { signal: init.signal } : {}),
  });
  if (!res.ok) throw await errorFrom(res, 'Could not read the run draft');
  const draft = normalizeRunDraft(await res.json());
  if (!draft) throw Object.assign(new Error('The run draft answer had no draft'), { status: 502 }) as DocumentWorkRequestError;
  return draft;
}

/** `PUT /api/documents/:documentId/run-drafts/:draftId` — an idempotent upsert keyed by `draftId`. */
export async function putRunDraft(
  apiBaseUrl: string, idToken: string | null, documentId: string, draftId: string, body: RunDraftPutBody,
): Promise<RunDraft> {
  const res = await fetch(`${apiBaseUrl}/api/documents/${enc(documentId)}/run-drafts/${enc(draftId)}`, {
    method: 'PUT',
    headers: headers(idToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res, 'Could not save the run draft');
  const draft = normalizeRunDraft(await res.json());
  if (!draft) throw Object.assign(new Error('The run draft answer had no draft'), { status: 502 }) as DocumentWorkRequestError;
  return draft;
}

/** `POST /api/documents/:documentId/run-drafts/:draftId/dispatch` — safe to retry: the draft id is the idempotency key. */
export async function dispatchRunDraft(
  apiBaseUrl: string, idToken: string | null, documentId: string, draftId: string,
): Promise<RunDraft> {
  const res = await fetch(`${apiBaseUrl}/api/documents/${enc(documentId)}/run-drafts/${enc(draftId)}/dispatch`, {
    method: 'POST',
    headers: headers(idToken, { 'Content-Type': 'application/json' }),
    body: '{}',
  });
  if (!res.ok) throw await errorFrom(res, 'Could not dispatch the run');
  const draft = normalizeRunDraft(await res.json());
  if (!draft) throw Object.assign(new Error('The dispatch answer had no draft'), { status: 502 }) as DocumentWorkRequestError;
  return draft;
}

/** `POST /api/pipelines/:runId/cancel` — the existing cancel route, forwarded to the replica holding the run. */
export async function cancelDraftRun(
  apiBaseUrl: string, idToken: string | null, runId: string, reason?: string,
): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/api/pipelines/${enc(runId)}/cancel`, {
    method: 'POST',
    headers: headers(idToken, { 'Content-Type': 'application/json', 'Idempotency-Key': `run-draft-cancel:${runId}` }),
    body: JSON.stringify(reason ? { reason } : {}),
  });
  if (!res.ok) throw await errorFrom(res, 'Could not stop the run');
}

/** `GET /api/pipelines/:pipelineId/estimate?model=` — `null` when the pipeline has no completed runs. */
export async function fetchRunEstimate(
  apiBaseUrl: string, idToken: string | null, pipelineId: string, model?: string | null, init?: { signal?: AbortSignal },
): Promise<RunEstimate | null> {
  const q = model ? `?model=${enc(model)}` : '';
  const res = await fetch(`${apiBaseUrl}/api/pipelines/${enc(pipelineId)}/estimate${q}`, {
    headers: headers(idToken), ...(init?.signal ? { signal: init.signal } : {}),
  });
  if (!res.ok) throw await errorFrom(res, 'Could not read the estimate');
  return normalizeRunEstimate(await res.json());
}

// ---------------------------------------------------------------------------
// Gateway signals
// ---------------------------------------------------------------------------

export const DOC_WORK_CHANNEL_PREFIX = 'doc-work:';
export const DOC_WORK_SCOPE_CHANNEL_PREFIX = 'doc-work-scope:';
export const docWorkChannel = (documentId: string) => `${DOC_WORK_CHANNEL_PREFIX}${documentId}`;
export const docWorkScopeChannel = (scopeId: string) => `${DOC_WORK_SCOPE_CHANNEL_PREFIX}${scopeId}`;

/** The gateway's `doc-work` service frames (realtime-examples `src/realtime-fanout/doc-work-service.ts`). */
export function docWorkSubscribeFrame(
  action: 'subscribe' | 'unsubscribe',
  target: { documentId: string } | { scopeId: string },
  documentGrant?: string | null,
): Record<string, unknown> {
  return { service: 'doc-work', action, ...target, ...(action === 'subscribe' && documentGrant ? { documentGrant } : {}) };
}

export type DocWorkSignal =
  | { type: 'doc:work_updated'; documentId: string; revision: number; fields?: string[]; status?: WorkStatus | null; rank?: string | null; channel?: string }
  | { type: 'doc:run_draft_updated'; documentId: string; draftId: string; status?: RunDraftStatus; revision: number; runId?: string; channel?: string };

/** A `doc-work:*` / `doc-work-scope:*` signal frame, or undefined for anything else. Reads `payload` or the frame itself. */
export function docWorkSignalFromFrame(frame: unknown): DocWorkSignal | undefined {
  const f = obj(frame);
  const type = f.type ?? f.eventType;
  if (type !== 'doc:work_updated' && type !== 'doc:run_draft_updated') return undefined;
  const p = f.payload && typeof f.payload === 'object' ? obj(f.payload) : f.data && typeof f.data === 'object' ? obj(f.data) : f;
  const documentId = str(p.documentId);
  if (!documentId) return undefined;
  const revision = num(p.revision) ?? 0;
  const channel = str(f.channel);
  if (type === 'doc:work_updated') {
    return {
      type, documentId, revision,
      ...(Array.isArray(p.fields) ? { fields: p.fields.filter((x): x is string => typeof x === 'string') } : {}),
      ...('status' in p ? { status: (str(p.status) ?? null) as WorkStatus | null } : {}),
      ...('rank' in p ? { rank: str(p.rank) ?? null } : {}),
      ...(channel ? { channel } : {}),
    };
  }
  const draftId = str(p.draftId);
  if (!draftId) return undefined;
  return {
    type, documentId, draftId, revision,
    ...(str(p.status) ? { status: str(p.status) as RunDraftStatus } : {}),
    ...(str(p.runId) ? { runId: str(p.runId) } : {}),
    ...(channel ? { channel } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared channel subscriptions
// ---------------------------------------------------------------------------

type SendFn = (frame: unknown) => void;
interface SubscriptionEntry { count: number; epoch: unknown }
const registry = new WeakMap<SendFn, Map<string, SubscriptionEntry>>();

/**
 * Refcounted subscribe over one transport. The gateway keeps one set of
 * channels per connection, so two hooks on the same channel must send one
 * subscribe and one unsubscribe between them — else the first to unmount
 * silences the other. A new session `epoch` is a new server-side connection
 * that has subscribed to nothing: the first acquirer after it re-sends.
 */
export function acquireChannelSubscription(
  send: SendFn,
  key: string,
  subscribeFrame: unknown,
  unsubscribeFrame: unknown,
  epoch?: unknown,
): () => void {
  let map = registry.get(send);
  if (!map) { map = new Map(); registry.set(send, map); }
  const entry = map.get(key);
  if (!entry) {
    map.set(key, { count: 1, epoch });
    send(subscribeFrame);
  } else {
    entry.count += 1;
    if (entry.epoch !== epoch) { entry.epoch = epoch; send(subscribeFrame); }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const m = registry.get(send);
    const e = m?.get(key);
    if (!m || !e) return;
    e.count -= 1;
    if (e.count <= 0) {
      m.delete(key);
      send(unsubscribeFrame);
    }
  };
}
