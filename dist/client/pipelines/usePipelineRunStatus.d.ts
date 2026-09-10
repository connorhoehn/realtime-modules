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
export interface PipelineRunRef {
    runId: string;
    pipelineId: string;
}
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
export declare const DEFAULT_STEP_LABELS: Record<string, string>;
/** Steps whose ids collide across pipelines read differently per pipeline. */
export declare const DEFAULT_PIPELINE_STEP_LABELS: Record<string, Record<string, string>>;
export interface StepLabelTables {
    stepLabels?: Record<string, string>;
    pipelineStepLabels?: Record<string, Record<string, string>>;
}
/** The label for a step: the pipeline-specific one, then the general one, then the raw id. */
export declare function stepLabelFor(stepId: string, pipelineId?: string, tables?: StepLabelTables): string;
/** "Retrying — attempt 2 of 3", or without the "of 3" when the budget is not known. */
export declare function retryLabel(attemptNumber: number, maxAttempts?: number): string;
/** The error a REST helper throws: the server's message, with the HTTP status attached (`409` = already reviewed). */
export type PipelineRunRequestError = Error & {
    status: number;
};
/**
 * Generic authenticated POST to platform-api. `path` is appended to
 * `apiBaseUrl` verbatim (e.g. `/api/documents/doc-1/agent-edit`); the JSON
 * body comes back typed as the caller says it does.
 */
export declare function requestPipelineRun<T = {
    runId: string;
    pipelineId: string;
}>(apiBaseUrl: string, idToken: string | null, path: string, body: unknown): Promise<T>;
/** Approve or reject the step a run is waiting on. Resolves when platform-api has recorded it. */
export declare function approvePipelineRun(apiBaseUrl: string, idToken: string | null, input: {
    runId: string;
    stepId: string;
    decision: PipelineRunDecision;
    comment?: string;
}): Promise<void>;
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
    review: PipelineRunReview & {
        suggestionKey: string;
        documentId: string;
        comment?: string;
        appliedByRunId?: string;
    };
    /** Present when `applyServerSide` was asked for: what the server did. */
    applied?: unknown;
}
/**
 * Accept or reject the suggestions a completed run left in a document.
 * Resolves with platform-api's record; throws a `PipelineRunRequestError`
 * on a non-2xx — `status === 409` means someone already reviewed it.
 */
export declare function reviewPipelineRun(apiBaseUrl: string, idToken: string | null, input: ReviewPipelineRunInput): Promise<ReviewPipelineRunResponse>;
/**
 * The one line a finished card shows. `outputs` is keyed by step id (the run's
 * final context carries them under `steps`; the snapshot path builds the same
 * map). Recording and transcription runs finish on their publish step; the
 * document runs on their apply step.
 */
export declare function runStatusDetail(outputs: Record<string, unknown> | undefined): string | undefined;
/** "Accepted by Grace" / "Rejected by Grace" — the name, falling back to the id. */
export declare function reviewDetail(review: PipelineRunReview): string;
/** A well-formed review record from a snapshot's `review` or a `pipeline.run.reviewed` payload; `undefined` otherwise. */
export declare function reviewOf(raw: unknown): PipelineRunReview | undefined;
/** The suggestion a completed run left behind, when its apply step ran in `mode: 'suggest'`. */
export declare function suggestionOf(outputs: Record<string, unknown> | undefined, context?: Record<string, unknown>): PipelineRunSuggestion | undefined;
/** A completed run whose suggestions nobody has accepted or rejected yet — terminal for the phase, not for the card. */
export declare function isAwaitingReview(status: PipelineRunStatus | undefined): boolean;
/** `pipeline:run:completed` and `pipeline.run.completed` are the same event. */
export declare function normalizeEventType(eventType: unknown): string | undefined;
type Step = {
    stepId?: string;
    nodeId?: string;
    status?: string;
    output?: unknown;
    error?: {
        message?: string;
    } | string;
    startedAt?: string;
    completedAt?: string;
    attempts?: Array<{
        attemptNumber?: number;
        error?: string;
    }>;
};
export interface PipelineRunSnapshot {
    status?: string;
    currentStepIds?: string[];
    steps?: Step[] | Record<string, Step>;
    error?: {
        message?: string;
    } | string;
    context?: Record<string, unknown>;
    trigger?: Record<string, unknown>;
    rejection?: unknown;
    result?: unknown;
    output?: unknown;
    startedAt?: string;
    completedAt?: string;
    /** Present once someone accepted or rejected the run's suggestions. */
    review?: unknown;
    pipelineDefinitionSnapshot?: {
        nodes?: Array<{
            id: string;
            data?: {
                retryPolicy?: {
                    maxAttempts?: number;
                };
            };
        }>;
    };
}
/** The step's label for a timeline: the narration without its trailing ellipsis. */
export declare function stepTimelineLabel(stepId: string, pipelineId?: string, tables?: StepLabelTables): string;
/**
 * The snapshot's steps in the order a person reads them: the trigger first,
 * then by `startedAt` among the steps that have one — a step without a
 * timestamp keeps its place in the record. The definition's node order is
 * not known here.
 */
export declare function stepsFromSnapshot(snap: PipelineRunSnapshot, pipelineId?: string, tables?: StepLabelTables): PipelineRunStepDetail[] | undefined;
/** platform-api's DocOp objects, flattened for a card: text cut short, only the fields that name what happened. */
export declare function opsFromApplyOutput(applyOutput: unknown): PipelineRunOpDetail[] | undefined;
/**
 * A snippet of the document from the read step's outline — `title: …` dropped,
 * each `#N kind(h2)(macro): ` prefix stripped, `(empty)` lines skipped — cut
 * to ~200 chars.
 */
export declare function snippetFromOutline(outline: unknown): string | undefined;
/** The document a run worked on, from the trigger/context/apply output; title and snippet from the read step, falling back to what apply wrote. */
export declare function documentFromOutputs(outputs: Record<string, unknown> | undefined, context?: Record<string, unknown>): PipelineRunDocumentDetail | undefined;
/** `next` laid over `prev`, field by field — a field the newer source lacks keeps the older value. Never clears. */
export declare function mergeDetails(prev: PipelineRunDetails | undefined, next: PipelineRunDetails | undefined): PipelineRunDetails | undefined;
/** The expanded card's details from a run snapshot, laid over what was already known. */
export declare function detailsFromSnapshot(snap: PipelineRunSnapshot, prev?: PipelineRunDetails, pipelineId?: string, tables?: StepLabelTables): PipelineRunDetails | undefined;
/** The card's status from a run snapshot; `undefined` when the snapshot says nothing new (pending). */
export declare function statusFromSnapshot(snap: PipelineRunSnapshot, prev?: PipelineRunStatus, pipelineId?: string, tables?: StepLabelTables): PipelineRunStatus | undefined;
/**
 * A terminal status learned from a frame, filled in from the snapshot that
 * arrives after it: a placeholder line ("Done" / "The run failed") gives way
 * to the snapshot's, a missing result/suggestion/review/noop is taken, and
 * the details merge. The phase itself is never walked back. Returns `cur`
 * itself when nothing changed.
 */
export declare function enrichTerminalStatus(cur: PipelineRunStatus, snap: PipelineRunSnapshot, pipelineId?: string, tables?: StepLabelTables): PipelineRunStatus;
/** The card's status after one live frame; `undefined` when the frame is not about the card. */
export declare function statusFromEvent(eventType: string | undefined, p: Record<string, unknown>, prev: PipelineRunStatus | undefined, pipelineId?: string, tables?: StepLabelTables): PipelineRunStatus | undefined;
export declare const DEFAULT_POLL_MS = 1500;
export declare const DEFAULT_REVIEW_POLL_MS = 15000;
export declare function usePipelineRunStatus(runs: readonly PipelineRunRef[], opts: UsePipelineRunStatusOptions): (runId: string) => PipelineRunStatus | undefined;
export default usePipelineRunStatus;
//# sourceMappingURL=usePipelineRunStatus.d.ts.map