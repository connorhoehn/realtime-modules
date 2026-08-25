export interface BackgroundOption {
    id: string;
    label: string;
    /** Image URL — for built-ins, a data: URI. */
    url: string;
}
/** Memoized: gradients render once per page, then the same array (and the
 *  same data-URI strings, so persisted urls keep matching) is returned. */
export declare function getBuiltInBackgrounds(): BackgroundOption[];
//# sourceMappingURL=backgrounds.d.ts.map