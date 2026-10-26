import { type CapabilityProvider } from '@connorhoehn/service-runtime/capabilities';
import type { FeatureManifest } from '../feature-manifest/types';
export interface CompositionFeature {
    manifest: FeatureManifest;
    serviceName?: string;
}
export interface RealtimeComposition<T extends CompositionFeature> {
    /** Stable dependency order. Independent features retain their input priority. */
    features: readonly T[];
    /** Resolve either a manifest identity or its wire alias. */
    serviceName(name: string): string | undefined;
}
/** Pure preflight: no service construction, transport listeners or live probes. */
export declare function planRealtimeComposition<T extends CompositionFeature>(features: readonly T[], providers?: readonly CapabilityProvider[]): RealtimeComposition<T>;
export type { CapabilityProvider, CapabilityRequirement } from '@connorhoehn/service-runtime/capabilities';
//# sourceMappingURL=composition.d.ts.map