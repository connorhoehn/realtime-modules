import type { PipelineRunTransport } from './pipelines/usePipelineRunStatus';
export type DeckRevisePhase = 'started' | 'reading-sources' | 'asking-model' | 'checking' | 'completed' | 'failed';
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
}
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