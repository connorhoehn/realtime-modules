import { assertCapabilities, type CapabilityProvider, type CapabilityRequirement } from '@connorhoehn/service-runtime/capabilities';
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

const identifier = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/;

/** Pure preflight: no service construction, transport listeners or live probes. */
export function planRealtimeComposition<T extends CompositionFeature>(
    features: readonly T[],
    providers: readonly CapabilityProvider[] = [],
): RealtimeComposition<T> {
    if (!Array.isArray(features)) throw new Error('Realtime composition: features must be an array');
    const identities = new Map<string, T>();
    const aliases = new Map<string, T>();
    const wires = new Map<T, string>();
    for (const feature of features) {
        const name = feature?.manifest?.name;
        const wire = feature?.serviceName ?? name;
        if (typeof name !== 'string' || !identifier.test(name) || typeof wire !== 'string' || !identifier.test(wire)) {
            throw new Error('Realtime composition: feature identity and serviceName must be valid identifiers');
        }
        if (identities.has(name)) throw new Error(`Realtime composition: duplicate feature '${name}'`);
        identities.set(name, feature);
        wires.set(feature, wire);
        for (const alias of new Set([name, wire])) {
            if (aliases.has(alias)) throw new Error(`Realtime composition: ambiguous or duplicate service alias '${alias}'`);
            aliases.set(alias, feature);
        }
    }
    const dependencies = new Map<T, Set<T>>();
    const requirements: CapabilityRequirement[] = [];
    for (const feature of features) {
        const name = feature.manifest.name;
        const declared = feature.manifest.dependencies ?? [];
        if (!Array.isArray(declared)) throw new Error(`Realtime composition: '${name}' dependencies must be an array`);
        const resolved = new Set<T>();
        for (const dependency of declared) {
            const target = aliases.get(dependency);
            if (!target) throw new Error(`Realtime composition: '${name}' requires missing feature '${dependency}'`);
            resolved.add(target);
        }
        dependencies.set(feature, resolved);
        const adapters = feature.manifest.adapterRequirements ?? [];
        if (!Array.isArray(adapters)) throw new Error(`Realtime composition: '${name}' adapterRequirements must be an array`);
        for (const requirement of adapters) requirements.push({ ...requirement, feature: name });
    }
    assertCapabilities(providers, requirements);
    const remaining = new Set(features);
    const ordered: T[] = [];
    while (remaining.size) {
        const next = features.find(feature => remaining.has(feature) &&
            [...dependencies.get(feature)!].every(dependency => !remaining.has(dependency)));
        if (!next) throw new Error(`Realtime composition: dependency cycle among ${[...remaining].map(f => f.manifest.name).join(', ')}`);
        ordered.push(next);
        remaining.delete(next);
    }
    return { features: ordered, serviceName: name => {
        const feature = aliases.get(name);
        return feature ? wires.get(feature) : undefined;
    } };
}

export type { CapabilityProvider, CapabilityRequirement } from '@connorhoehn/service-runtime/capabilities';
