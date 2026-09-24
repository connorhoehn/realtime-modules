import type { PipelineRunTransport } from './pipelines/usePipelineRunStatus';
export interface PresentationSlideSummary {
    id: string;
    index: number;
    title: string;
    previewHandle?: string;
}
/** One revision, as the platform's revision routes shape it. */
export interface PresentationRevisionSummary {
    id: string;
    label: string;
    createdAt: string;
    createdBy: string;
    slideCount: number;
    contentType?: string;
    sizeBytes?: number;
    /** Whether the spec it was rendered from was kept (false: readable, not re-editable). */
    hasSpec?: boolean;
    sources?: Array<{
        documentId: string;
        title: string;
        kind?: 'document' | 'transcript';
    }>;
    /** The run that wrote it, for a composer edit. */
    producedBy?: {
        pipelineId: string;
        runId: string;
        requestId: string;
    };
    /** The deck's own title, sent only where it differs from the document's. */
    heading?: string;
    slides: PresentationSlideSummary[];
    /**
     * False for a revision a page named without its slide list (every one but
     * the head): `slides` is empty until it is focused. Absent means true.
     */
    slidesLoaded?: boolean;
}
/** Revisions per page. A deck keeps every revision (v40+ happens). */
export declare const PRESENTATION_REVISION_PAGE_SIZE = 10;
export type PresentationRevisionsStatus = 'loading' | 'ready' | 'empty' | 'error' | 'no-access';
export interface UsePresentationRevisionsOptions {
    /** platform-api origin, e.g. `http://localhost:13001`. */
    apiBaseUrl: string;
    documentId: string;
    /** Bearer. Null reads nothing. */
    idToken: string | null;
    /**
     * A revision the view must be able to show even when it is older than the
     * pages in hand (a `?revision=` link, a run card's revision, a pick from
     * the older list): read on its own, without marking the pages between as read.
     */
    focusRevisionId?: string | null;
    /** Default 10. Views sharing a cache should agree; the first view's size wins. */
    pageSize?: number;
    /** The deck channel's socket (see useDeckReviseStatus). Omit for the provider's; `null` turns the live prepend off. */
    transport?: PipelineRunTransport | null;
    /** For tests. Default `globalThis.fetch`. */
    fetchImpl?: typeof fetch;
}
export interface UsePresentationRevisionsResult {
    /** The deck document's title ('Presentation' until read). */
    title: string;
    /** Oldest first — only the pages (and focused revisions) read so far. */
    revisions: PresentationRevisionSummary[];
    /** Every revision the deck has, read or not. */
    total: number;
    /** Revisions older than the oldest paged one; `loadOlder` reads the next page. */
    olderCount: number;
    loadingOlder: boolean;
    loadOlder: () => void;
    /** `no-access`: 403/404 — the platform answers a deck you may not open like a missing one. */
    state: PresentationRevisionsStatus;
    error: string | null;
    /** Re-read the head page (keeps older pages: a revision never changes). */
    reload: () => void;
}
/** Oldest first, one entry per id; a copy with its slides wins over one without. */
export declare function mergePresentationRevisions(...lists: PresentationRevisionSummary[][]): PresentationRevisionSummary[];
/** Drops every held list (sign-out, tests). */
export declare function releasePresentationRevisions(): void;
export declare function usePresentationRevisions(opts: UsePresentationRevisionsOptions): UsePresentationRevisionsResult;
//# sourceMappingURL=usePresentationRevisions.d.ts.map