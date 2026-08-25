export interface FilterPreset {
    id: string;
    label: string;
    /** CSS filter string assigned to ctx.filter before drawImage. */
    cssFilter: string;
}
export declare const FILTER_PRESETS: FilterPreset[];
export declare const DEFAULT_FILTER: FilterPreset;
/** Unknown or missing ids fall back to DEFAULT_FILTER ('none') so a stale
 *  persisted id can never crash the draw loop. */
export declare function getFilterById(id: string | undefined): FilterPreset;
//# sourceMappingURL=presets.d.ts.map