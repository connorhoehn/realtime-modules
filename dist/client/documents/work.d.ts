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
export type WorkCriterionOp = {
    op: 'add';
    id: string;
    text: string;
    rank?: string;
} | {
    op: 'check';
    id: string;
    done: boolean;
} | {
    op: 'edit';
    id: string;
    text: string;
} | {
    op: 'remove';
    id: string;
} | {
    op: 'move';
    id: string;
    rank: string;
};
/** One link operation, keyed by a client-made id. */
export type WorkLinkOp = {
    op: 'add';
    id: string;
    documentId: string;
    relation: WorkLinkRelation;
} | {
    op: 'edit';
    id: string;
    relation: WorkLinkRelation;
} | {
    op: 'remove';
    id: string;
};
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
export declare function newWorkItemId(): string;
/** A rank strictly after `last` (or the first one) — enough for appending; drag order is the host's. */
export declare function rankAfter(last?: string): string;
/**
 * The optimistic view of a PATCH: what the row looks like if the platform
 * applies it. Pure, and forgiving the way the server is — a check on a
 * criterion that no longer exists changes nothing.
 */
export declare function applyWorkUpdate(work: DocumentWork, update: WorkUpdate): DocumentWork;
/** The criteria in display order (by `rank`, then id). */
export declare function orderedCriteria(work: Pick<DocumentWork, 'criteria'>): Array<WorkCriterion & {
    id: string;
}>;
/** A platform row (or `{ work }` envelope) in the shape above, with maps defaulted. */
export declare function normalizeDocumentWork(raw: unknown, documentId?: string): DocumentWork;
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
export declare const WORK_STATUS_LABEL: Record<WorkGroupKey, string>;
/** Group order in the Work column. Untracked rows sit under "Not planned", never "Next up". */
export declare const WORK_GROUP_ORDER: readonly WorkGroupKey[];
export interface WorkGroup {
    key: WorkGroupKey;
    label: string;
    count: number;
    rows: WorkListRow[];
}
export declare function workGroupOf(row: Pick<DocumentWork, 'status'>): WorkGroupKey;
/** Rows grouped by work status, in `WORK_GROUP_ORDER`, each sorted by `rank`. Empty groups are left out unless asked for. */
export declare function groupWorkRows(rows: readonly WorkListRow[], opts?: {
    includeEmpty?: boolean;
}): WorkGroup[];
/** Σ points of `done` rows out of Σ over all rows — what the header reads, recomputed after a live merge. */
export declare function pointsRollup(rows: readonly WorkListRow[]): Pick<WorkRollup, 'pointsDone' | 'pointsTotal'>;
export declare function normalizeWorkList(raw: unknown, scope: string): WorkListResponse;
/** Merge a re-read work record into its list row, keeping the list-only fields (lifecycle status, live run). */
export declare function mergeWorkIntoRow(row: WorkListRow | undefined, work: DocumentWork): WorkListRow;
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
    sources?: Array<{
        kind: RunDraftSourceKind;
        id: string;
    }>;
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
    sources?: Array<{
        kind: RunDraftSourceKind;
        id: string;
    }>;
    generate?: boolean;
}
export interface RunDraftPutBody extends RunDraftInput {
    /** Needed when the body differs from the stored draft (409 otherwise). */
    expectedRevision?: number;
}
/** A draft stuck in `dispatching` this long reads as "Dispatch not confirmed — Retry" (§2.2). */
export declare const RUN_DRAFT_DISPATCH_STALE_MS = 60000;
export type RunDraftPhase = 'none' | 'draft' | 'dispatching' | 'unconfirmed' | 'dispatched' | 'cancelled';
/** What the Run draft pane says about a draft. */
export declare function runDraftPhase(draft: RunDraft | null | undefined, now?: number): RunDraftPhase;
export declare function normalizeRunDraft(raw: unknown): RunDraft | null;
/** The draft the pane shows: the newest one not cancelled, else the newest. */
export declare function currentRunDraft(drafts: readonly RunDraft[]): RunDraft | null;
export type RunEstimateConfidence = 'none' | 'low' | 'medium';
export interface RunEstimate {
    pipelineId: string;
    basis: {
        runs: number;
        model?: string;
        repriced: boolean;
    };
    costUsd: {
        low: number;
        high: number;
    } | null;
    durationMs: {
        low: number;
        high: number;
    } | null;
    confidence: RunEstimateConfidence;
}
/** `null` means "No prior runs": the UI shows no number (a range is never shown with n = 0). */
export declare function normalizeRunEstimate(raw: unknown): RunEstimate | null;
/** The error a documents-work request throws: the server's message, the HTTP status and, when sent, its code and body. */
export type DocumentWorkRequestError = Error & {
    status: number;
    code?: string;
    body?: Record<string, unknown>;
};
/** `GET /api/documents/:documentId/work` — backfilled on read when absent (`tracked: false`, revision 0). */
export declare function fetchDocumentWork(apiBaseUrl: string, idToken: string | null, documentId: string, init?: {
    signal?: AbortSignal;
}): Promise<DocumentWork>;
/**
 * `PATCH /api/documents/:documentId/work`. A 409 (a field this PATCH changes
 * moved on since `expectedRevision`) throws with `status: 409`.
 */
export declare function patchDocumentWork(apiBaseUrl: string, idToken: string | null, documentId: string, body: WorkPatchBody): Promise<DocumentWork>;
/** `GET /api/document-work?scope=<parentId|type:<type>>` — the Work column. */
export declare function fetchWorkList(apiBaseUrl: string, idToken: string | null, scope: string, init?: {
    signal?: AbortSignal;
}): Promise<WorkListResponse>;
/** `GET /api/documents/:documentId/run-drafts` — the document's drafts, newest state of each. */
export declare function fetchRunDrafts(apiBaseUrl: string, idToken: string | null, documentId: string, init?: {
    signal?: AbortSignal;
}): Promise<RunDraft[]>;
/** `GET /api/documents/:documentId/run-drafts/:draftId`. */
export declare function fetchRunDraft(apiBaseUrl: string, idToken: string | null, documentId: string, draftId: string, init?: {
    signal?: AbortSignal;
}): Promise<RunDraft>;
/** `PUT /api/documents/:documentId/run-drafts/:draftId` — an idempotent upsert keyed by `draftId`. */
export declare function putRunDraft(apiBaseUrl: string, idToken: string | null, documentId: string, draftId: string, body: RunDraftPutBody): Promise<RunDraft>;
/** `POST /api/documents/:documentId/run-drafts/:draftId/dispatch` — safe to retry: the draft id is the idempotency key. */
export declare function dispatchRunDraft(apiBaseUrl: string, idToken: string | null, documentId: string, draftId: string): Promise<RunDraft>;
/** `POST /api/pipelines/:runId/cancel` — the existing cancel route, forwarded to the replica holding the run. */
export declare function cancelDraftRun(apiBaseUrl: string, idToken: string | null, runId: string, reason?: string): Promise<void>;
/** `GET /api/pipelines/:pipelineId/estimate?model=` — `null` when the pipeline has no completed runs. */
export declare function fetchRunEstimate(apiBaseUrl: string, idToken: string | null, pipelineId: string, model?: string | null, init?: {
    signal?: AbortSignal;
}): Promise<RunEstimate | null>;
export declare const DOC_WORK_CHANNEL_PREFIX = "doc-work:";
export declare const DOC_WORK_SCOPE_CHANNEL_PREFIX = "doc-work-scope:";
export declare const docWorkChannel: (documentId: string) => string;
export declare const docWorkScopeChannel: (scopeId: string) => string;
/** The gateway's `doc-work` service frames (realtime-examples `src/realtime-fanout/doc-work-service.ts`). */
export declare function docWorkSubscribeFrame(action: 'subscribe' | 'unsubscribe', target: {
    documentId: string;
} | {
    scopeId: string;
}, documentGrant?: string | null): Record<string, unknown>;
export type DocWorkSignal = {
    type: 'doc:work_updated';
    documentId: string;
    revision: number;
    fields?: string[];
    status?: WorkStatus | null;
    rank?: string | null;
    channel?: string;
} | {
    type: 'doc:run_draft_updated';
    documentId: string;
    draftId: string;
    status?: RunDraftStatus;
    revision: number;
    runId?: string;
    channel?: string;
};
/** A `doc-work:*` / `doc-work-scope:*` signal frame, or undefined for anything else. Reads `payload` or the frame itself. */
export declare function docWorkSignalFromFrame(frame: unknown): DocWorkSignal | undefined;
type SendFn = (frame: unknown) => void;
/**
 * Refcounted subscribe over one transport. The gateway keeps one set of
 * channels per connection, so two hooks on the same channel must send one
 * subscribe and one unsubscribe between them — else the first to unmount
 * silences the other. A new session `epoch` is a new server-side connection
 * that has subscribed to nothing: the first acquirer after it re-sends.
 */
export declare function acquireChannelSubscription(send: SendFn, key: string, subscribeFrame: unknown, unsubscribeFrame: unknown, epoch?: unknown): () => void;
export {};
//# sourceMappingURL=work.d.ts.map