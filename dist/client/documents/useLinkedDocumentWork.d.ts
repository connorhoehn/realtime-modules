import type { DocumentWork } from './work';
import type { DocumentsLiveOptions } from './transport';
export interface LinkedDocumentWorkResult {
    /** Each readable linked document's row, by id. Absent until its first read lands. */
    work: Readonly<Record<string, DocumentWork>>;
    /** Linked ids the viewer may not read (the read answered 403 or 404). */
    restricted: ReadonlySet<string>;
    /** Re-read every linked row. */
    refresh: () => void;
}
export declare function useLinkedDocumentWork(documentIds: readonly string[], opts: DocumentsLiveOptions): LinkedDocumentWorkResult;
//# sourceMappingURL=useLinkedDocumentWork.d.ts.map