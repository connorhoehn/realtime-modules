import type { DocumentSearchFacets, DocumentSearchFilters, DocumentSearchItem, DocumentSearchSort } from './search';
export interface UseDocumentSearchOptions {
    /** platform-api origin, e.g. `http://localhost:3001`. */
    apiBaseUrl: string;
    /** Bearer; `null` leaves the hook idle. */
    idToken: string | null;
    query: string;
    /** Default: `relevance` with words, `updated` without. */
    sort?: DocumentSearchSort;
    filters?: DocumentSearchFilters;
    /** Page size. Default 30. */
    limit?: number;
    debounceMs?: number;
    /** Change it to re-read the first page. */
    refreshKey?: unknown;
    enabled?: boolean;
}
export interface UseDocumentSearchResult {
    items: readonly DocumentSearchItem[];
    /** Matches across all pages. */
    total: number;
    /** Documents the viewer may read at all. */
    libraryTotal: number;
    facets: DocumentSearchFacets;
    /** The words the shown rows answer (lags `query` by the debounce). */
    settledQuery: string;
    loading: boolean;
    loadingMore: boolean;
    error?: string;
    hasMore: boolean;
    loadMore: () => void;
    refresh: () => void;
}
export declare function useDocumentSearch(opts: UseDocumentSearchOptions): UseDocumentSearchResult;
//# sourceMappingURL=useDocumentSearch.d.ts.map