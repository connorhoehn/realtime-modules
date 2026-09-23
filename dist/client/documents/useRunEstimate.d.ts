import type { RunEstimate } from './work';
import type { DocumentsLiveOptions } from './transport';
export type UseRunEstimateOptions = DocumentsLiveOptions;
export interface UseRunEstimateResult {
    /** `null` = "No prior runs" (also `null` while loading — check `loading`). */
    estimate: RunEstimate | null;
    /** True once a read settled with no prior runs. */
    noPriorRuns: boolean;
    loading: boolean;
    error?: string;
    refresh: () => void;
}
/** Drop every cached estimate for a pipeline (all models). */
export declare function invalidateRunEstimates(pipelineId?: string): void;
export declare function useRunEstimate(pipelineId: string | null | undefined, model: string | null | undefined, opts: UseRunEstimateOptions): UseRunEstimateResult;
//# sourceMappingURL=useRunEstimate.d.ts.map