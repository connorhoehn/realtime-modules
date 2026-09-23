/** The group a pipeline sits under on the page. */
export type WorkType = 'documents' | 'agents' | 'conversations' | 'other';
/** Alias of `WorkType` for hosts that namespace their imports. */
export type PipelineWorkType = WorkType;
export declare const WORK_TYPE_LABEL: Record<WorkType, string>;
/** The order the groups render in. Empty groups are not rendered. */
export declare const WORK_TYPE_ORDER: WorkType[];
/** The row mark. Each kind belongs to exactly one work type (`KIND_WORK_TYPE`). */
export type PipelineKind = 'document' | 'presentation' | 'diagram' | 'agent' | 'experiment' | 'recording' | 'call' | 'conversation' | 'media' | 'workflow';
export declare const PIPELINE_KIND_ORDER: readonly PipelineKind[];
/** platform-api's name for the same list. */
export declare const PIPELINE_KINDS: readonly PipelineKind[];
/**
 * The ui-components `FileKindMark` kind for each pipeline kind. Strings, not
 * the library's type: this package does not depend on ui-components, and the
 * host's `FileKind` union accepts every value here.
 */
export declare const KIND_MARK: Record<PipelineKind, string>;
export declare const KIND_WORK_TYPE: Record<PipelineKind, WorkType>;
export declare const KIND_LABEL: Record<PipelineKind, string>;
export declare function isWorkType(v: unknown): v is WorkType;
export declare function isPipelineKind(v: unknown): v is PipelineKind;
/** The definition's own lifecycle — unchanged from the host's `PipelineStatus`. */
export type PipelineDefinitionStatus = 'draft' | 'published' | 'archived';
export type OriginKind = 'system' | 'template' | 'agent' | 'blank' | 'import';
export declare const ORIGIN_KINDS: readonly OriginKind[];
/** The longest instruction `origin.instruction` and `/generate` accept. */
export declare const MAX_INSTRUCTION_CHARS = 4000;
/** `route` shows this many steps before the platform folds the rest into "… +N". */
export declare const MAX_ROUTE_ENTRIES = 6;
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
/**
 * A run as the rollup sees it: the run-list item statuses plus the
 * platform-only `interrupted` (force-failed after an orphan) and `stuck`
 * (nobody has heard from it). Mirrors platform-api's `RollupRunStatus`.
 */
export type RunItemStatus = 'pending' | 'running' | 'awaiting_approval' | 'paused_at_breakpoint' | 'completed' | 'failed' | 'cancelled' | 'rejected' | 'interrupted' | 'stuck';
/** Aliases of `RunItemStatus`: platform-api's name, and a namespaced one. */
export type RollupRunStatus = RunItemStatus;
export type PipelineRunItemStatus = RunItemStatus;
export declare const RUN_ITEM_STATUSES: readonly RunItemStatus[];
/** How many runs a rollup remembers (platform-api `RECENT_LIMIT`). */
export declare const ROLLUP_RECENT_LIMIT = 5;
export declare const RECENT_LIMIT = 5;
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
/** failed | interrupted | stuck — what `failedOfRecent` counts. */
export declare function isFailedRunStatus(status: RunItemStatus | null | undefined): boolean;
/** pending | running | awaiting_approval | paused_at_breakpoint — what `runningCount` counts. */
export declare function isActiveRunStatus(status: RunItemStatus | null | undefined): boolean;
/**
 * completed | failed | cancelled | rejected. `interrupted` and `stuck` are
 * NOT terminal: a stuck run may still finish, and the platform applies both
 * as live states a later terminal event can overwrite.
 */
export declare function isTerminalRunStatus(status: RunItemStatus | null | undefined): boolean;
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
export declare function workTypeOf(def: Pick<PipelineCatalogDefinition, 'workType' | 'kind'>): WorkType;
/** Kind of an entry: the explicit field, else 'workflow'. */
export declare function kindOf(def: Pick<PipelineCatalogDefinition, 'kind'>): PipelineKind;
export declare function summarize(entry: PipelineCatalogEntry): PipelineDefinitionSummary;
export declare function summarizeAll(entries: readonly PipelineCatalogEntry[]): PipelineDefinitionSummary[];
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
/**
 * Row order inside a group: something in flight first, then by most recent
 * run, then by most recently edited, then by name so the order is total.
 */
export declare function compareSummaries(a: PipelineDefinitionSummary, b: PipelineDefinitionSummary): number;
export declare function sortSummaries(summaries: readonly PipelineDefinitionSummary[]): PipelineDefinitionSummary[];
/**
 * Group summaries for the page. Groups follow the enum's order, empty groups
 * are omitted, and the rows inside each are sorted by `compareSummaries`.
 */
export declare function groupCatalog(summaries: readonly PipelineDefinitionSummary[], by?: CatalogGroupBy): PipelineCatalogGroup[];
/** `groupCatalog(summaries, 'workType')` — the page's default. */
export declare function groupByWorkType(summaries: readonly PipelineDefinitionSummary[]): PipelineCatalogGroup[];
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
export declare function relativeTime(iso: string | undefined, now?: number): string;
/**
 * The pill for a row (PLAN §2.2): a run in flight → info; the newest run
 * failed → danger "Failed · 10h ago"; some of the recent runs failed →
 * warning "1 of 5 failed · 29m ago"; otherwise the definition's own status.
 */
export declare function statusPillFor(summary: PipelineDefinitionSummary, now?: number): PipelineStatusPill;
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
export declare const RUN_EVENT_STATUS: Record<string, RunItemStatus>;
/**
 * Parse a gateway `pipeline:event` frame into a rollup event, or `undefined`
 * when the frame is not one (a step, a token, a checkpoint, an approval …) or
 * names no pipeline. The event time is the payload's `at` (or its own stamp)
 * when it carries one, else the envelope's `emittedAt`, else `now`.
 */
export declare function runEventFromFrame(frame: unknown, now?: () => string): RunRollupEvent | undefined;
/** The row a pipeline gets before any run: nothing recent (the platform's sentinel). */
export declare function emptyRollup(pipelineId: string, at: string): PipelineRunRollup;
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
export declare function applyRunEvent(existing: PipelineRunRollup | null, event: RunRollupEvent): PipelineRunRollup;
/**
 * Apply an event to the entry it names. Entries that are not the event's
 * pipeline keep their identity; an event for a pipeline not in the list is
 * ignored (the definition list is refreshed by the caller, not invented here).
 * Returns the SAME array when nothing changed.
 */
export declare function mergeRunEvent(entries: readonly PipelineCatalogEntry[], event: RunRollupEvent): readonly PipelineCatalogEntry[];
//# sourceMappingURL=catalog.d.ts.map