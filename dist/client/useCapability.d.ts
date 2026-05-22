export interface CapabilityDescriptor {
    /** Capability name, e.g. 'chat', 'presence'. Matches the CRD name. */
    name: string;
    /** Whether the capability is provisioned and active for this context. */
    enabled: boolean;
    /** Optional channel scope. When set, capability applies only to that channel. */
    channel?: string;
    /** Bundle version string from the CRD, if provided. */
    version?: string;
    /** Arbitrary metadata from the CRD (e.g. quotas, feature flags). */
    metadata?: Record<string, unknown>;
}
export interface UseCapabilityResult {
    /** Full descriptor as returned by the gateway, or null while loading. */
    capability: CapabilityDescriptor | null;
    /** Convenience boolean — false while loading, true/false after resolution. */
    enabled: boolean;
    /** True until the first resolution (REST response or WS frame) arrives. */
    isLoading: boolean;
    /** Set when the REST call fails with a non-404 error. */
    error?: Error;
}
/**
 * Discovers whether a capability is available in the current gateway session.
 *
 * Apps can render conditionally:
 *
 * ```tsx
 * const { enabled } = useCapability('chat');
 * if (!enabled) return <ChatNotAvailable />;
 * return <ChatPanel />;
 * ```
 *
 * On gateway side, capabilities are derived from registered CRDs flowing
 * through ControlPlaneChannel.
 *
 * @param name    - Capability name, e.g. 'chat', 'presence'.
 * @param channel - Optional channel scope for the lookup.
 */
export declare function useCapability(name: string, channel?: string): UseCapabilityResult;
//# sourceMappingURL=useCapability.d.ts.map