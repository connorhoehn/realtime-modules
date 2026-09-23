import type { DocumentWork, WorkUpdate } from './work';
import type { DocumentsLiveOptions } from './transport';
export interface UseDocumentWorkOptions extends DocumentsLiveOptions {
    /** A per-document grant for the gateway's read check, when the host holds one. */
    documentGrant?: string | null;
}
export interface DocumentWorkConflict {
    /** The fields the server said moved on (from the 409 body), when it named them. */
    fields: string[];
    message: string;
}
export interface UseDocumentWorkResult {
    /** The row with queued edits applied; `null` until the first read. */
    work: DocumentWork | null;
    /** False while the platform has nothing stored (the row is a read-time backfill). */
    tracked: boolean;
    loading: boolean;
    error?: string;
    /** Apply an edit now and PATCH it. Resolves with the saved row; rejects (after rollback) on failure. */
    update: (update: WorkUpdate) => Promise<DocumentWork>;
    /** Edits sent or queued and not yet confirmed. */
    pending: number;
    /** Set by a 409 until the next successful edit or `clearConflict()`. */
    conflict: DocumentWorkConflict | null;
    clearConflict: () => void;
    refresh: () => void;
}
export declare function useDocumentWork(documentId: string | null | undefined, opts: UseDocumentWorkOptions): UseDocumentWorkResult;
//# sourceMappingURL=useDocumentWork.d.ts.map