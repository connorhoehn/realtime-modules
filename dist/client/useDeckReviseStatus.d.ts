import type { PipelineRunTransport } from './pipelines/usePipelineRunStatus';
export type DeckRevisePhase = 'started' | 'reading-sources' | 'waiting-for-model' | 'asking-model' | 'checking' | 'saving' | 'completed' | 'failed';
/** The part of a slide a revise was pointed at (platform `DeckReviseTarget`). */
export interface DeckReviseTargetRef {
    field: 'title' | 'eyebrow' | 'subtitle' | 'bullets' | 'columns' | 'chart' | 'quote' | 'image' | 'notes';
    index?: number;
}
export interface DeckReviseActivity {
    requestId: string;
    documentId: string;
    /** Who asked (the platform `sub`). */
    userId: string;
    scope: 'slide' | 'deck';
    slideId?: string;
    target?: DeckReviseTargetRef;
    phase: DeckRevisePhase;
    /** The phase as a task strip would say it ("Writing the edit"). */
    label: string;
    /** ms since epoch, from the server's `occurredAt` of the first event seen. */
    startedAt: number;
    /** ms since epoch of the latest event. */
    updatedAt: number;
    /** On `completed`. */
    changedSlideIds?: string[];
    /** On `failed`: the HTTP status the request answered with. */
    status?: number;
    /** On `failed`: the plain sentence the request answered with. */
    reason?: string;
    /** On `failed`: a machine code — `revision-conflict` when the base moved and the edit could not rebase. */
    code?: string;
    /**
     * The pipeline run doing the edit (`POST /api/deck/revise-run`, 0.81.0).
     * Absent for the older request/response `/api/deck/revise`.
     */
    pipelineRunId?: string;
    /** On `completed` of a run: the revision the pipeline wrote. `null` when the edit changed nothing. */
    revisionId?: string | null;
    /** On `completed`: the edit was re-applied on top of this newer revision (slide/field scope only). */
    rebasedOnto?: string;
    /** No terminal event arrived within `staleMs`: no longer counted as in flight. */
    stale?: boolean;
}
export interface UseDeckReviseStatusOptions {
    /** A host-owned socket. Omit to use the nearest GatewaySocketProvider; `null` disables. */
    transport?: PipelineRunTransport | null;
    /** How long an unfinished revise may go without an event. Default 60 000. */
    staleMs?: number;
    /** Settled revises kept in `recent`. Default 10. */
    keepRecent?: number;
    /** Clock, for tests. */
    now?: () => number;
}
export interface UseDeckReviseStatusResult {
    /** In-flight revises, oldest first. */
    active: DeckReviseActivity[];
    /** Settled revises (completed, failed or stale), newest first. */
    recent: DeckReviseActivity[];
    /** The newest revise, in flight or settled. */
    latest?: DeckReviseActivity;
    /** Slides an in-flight slide-scoped revise is editing — the filmstrip's "Generating…". */
    generatingSlideIds: string[];
    /** True while any revise (slide or deck) is in flight. */
    isGenerating: boolean;
    /** One revise by its requestId (the id the HTTP response also carries). */
    get: (requestId: string) => DeckReviseActivity | undefined;
    /**
     * The newest revision anyone wrote to this document while it was open — a
     * `/deck` generation, a revise run, a save or an Undo (0.94.0). From
     * `pipeline.deck.revise.revision-written`, or a revise's `completed` that
     * names one. A host reloads its revision list when this names one it lacks.
     */
    lastWritten?: DeckRevisionWritten;
}
/** A revision written to the document, as its channel announced it. */
export interface DeckRevisionWritten {
    revisionId: string;
    documentId: string;
    slideCount?: number;
    createdBy?: string;
    /** When the frame arrived (ms). */
    receivedAt: number;
}
/** The event that says a revision was written, whoever wrote it. */
export declare const DECK_REVISION_WRITTEN_EVENT = "pipeline.deck.revise.revision-written";
/**
 * The revision a frame says was written to `documentId`, or null. Reads
 * `revision-written`, and a `completed` revise that carries a revisionId.
 */
export declare function deckRevisionWrittenOf(frame: unknown, documentId: string, now: number): DeckRevisionWritten | null;
export declare const DEFAULT_DECK_REVISE_STALE_MS = 60000;
export declare const DECK_REVISE_EVENT_PREFIX = "pipeline.deck.revise.";
/** The gateway channel a document's revise events arrive on. */
export declare function deckReviseChannel(documentId: string): string;
export declare function deckRevisePhaseLabel(phase: DeckRevisePhase): string;
export declare function isDeckReviseSettled(activity: DeckReviseActivity): boolean;
/**
 * One frame into the per-request map. Pure; returns the same map when the
 * frame is not a revise event for `documentId`, or arrives after the
 * revise settled (a late `phase` never un-finishes it).
 */
export declare function reduceDeckReviseFrame(state: Readonly<Record<string, DeckReviseActivity>>, frame: unknown, documentId: string, now: number): Readonly<Record<string, DeckReviseActivity>>;
/** Marks unfinished revises with no event for `staleMs` as stale. Returns the same map when none are. */
export declare function markStaleDeckRevises(state: Readonly<Record<string, DeckReviseActivity>>, now: number, staleMs: number): Readonly<Record<string, DeckReviseActivity>>;
export declare function useDeckReviseStatus(documentId: string | null | undefined, opts?: UseDeckReviseStatusOptions): UseDeckReviseStatusResult;
export default useDeckReviseStatus;
//# sourceMappingURL=useDeckReviseStatus.d.ts.map