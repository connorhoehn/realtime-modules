import type { CapabilityDescriptor } from './useCapability';
export interface UseCapabilitiesResult {
    /** Descriptor per requested name. Missing until the first resolution lands. */
    capabilities: Record<string, CapabilityDescriptor>;
    /**
     * Flat name→boolean map, the shape most callers actually branch on.
     *
     * Every requested name is present and `false` while loading, so a caller that
     * renders straight off this map never flashes a control it is about to hide.
     */
    enabled: Record<string, boolean>;
    /** True until every requested name has resolved once. */
    isLoading: boolean;
    error?: Error;
}
export declare function useCapabilities(names: readonly string[], channel?: string): UseCapabilitiesResult;
export default useCapabilities;
//# sourceMappingURL=useCapabilities.d.ts.map