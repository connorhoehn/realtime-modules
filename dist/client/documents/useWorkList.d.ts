import type { WorkGroup, WorkListRow, WorkRollup } from './work';
import type { DocumentsLiveOptions } from './transport';
export interface UseWorkListOptions extends DocumentsLiveOptions {
    /** A grant on the scope's parent document for the gateway's read check, when the host holds one. */
    documentGrant?: string | null;
}
export interface UseWorkListResult {
    rows: readonly WorkListRow[];
    /** The header numbers; points are recomputed from the rows after each live merge. */
    rollup: WorkRollup | null;
    /** Rows grouped in `WORK_GROUP_ORDER`; empty groups omitted unless `includeEmpty`. */
    groups: (opts?: {
        includeEmpty?: boolean;
    }) => WorkGroup[];
    loading: boolean;
    error?: string;
    refresh: () => void;
}
export declare function useWorkList(scope: string | null | undefined, opts: UseWorkListOptions): UseWorkListResult;
//# sourceMappingURL=useWorkList.d.ts.map