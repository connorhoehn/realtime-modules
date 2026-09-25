export type DocumentSearchKind = 'page' | 'presentation' | 'diagram';
export type DocumentSearchSort = 'relevance' | 'updated' | 'name';
export type DocumentSearchMatch = 'title' | 'summary' | 'body';
export interface DocumentSearchFilters {
    kind?: readonly DocumentSearchKind[];
    owner?: readonly string[];
    /** A folder id (sub-folders included), or `unfiled`. */
    folder?: string | null;
    /** Changed at or after this epoch ms. */
    since?: number | null;
}
export interface DocumentSearchItem {
    id: string;
    title: string;
    kind: DocumentSearchKind;
    /** The row's own type (`page`, `presentation`, a custom type id…). */
    type: string;
    /** The opening sentence of a page, else the description; null when neither. */
    summary: string | null;
    folderId: string | null;
    folderName: string | null;
    ownerId: string | null;
    ownerName: string | null;
    updatedAt: string | null;
    match?: DocumentSearchMatch;
}
export interface DocumentSearchFacets {
    kinds: Array<{
        kind: DocumentSearchKind;
        count: number;
    }>;
    owners: Array<{
        id: string;
        name: string;
        count: number;
    }>;
    folders: Array<{
        id: string;
        name: string;
        parentFolderId: string | null;
        count: number;
    }>;
}
export interface DocumentSearchPage {
    query: string;
    sort: DocumentSearchSort;
    total: number;
    libraryTotal: number;
    items: DocumentSearchItem[];
    nextCursor: string | null;
    facets: DocumentSearchFacets;
}
export declare function normalizeDocumentSearchItem(raw: unknown): DocumentSearchItem | null;
export declare function normalizeDocumentSearchPage(raw: unknown): DocumentSearchPage;
export interface DocumentSearchQuery {
    q: string;
    sort?: DocumentSearchSort;
    filters?: DocumentSearchFilters;
    limit?: number;
    cursor?: string | null;
    /** Skip the server's row cache — the document list just changed. */
    fresh?: boolean;
}
export declare function documentSearchUrl(apiBaseUrl: string, query: DocumentSearchQuery): string;
/** `GET /api/document-search`. */
export declare function fetchDocumentSearch(apiBaseUrl: string, idToken: string | null, query: DocumentSearchQuery, init?: {
    signal?: AbortSignal;
}): Promise<DocumentSearchPage>;
//# sourceMappingURL=search.d.ts.map