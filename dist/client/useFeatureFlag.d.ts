export interface UseFeatureFlagResult {
    /** Whether the flag is enabled for the current user/context. */
    enabled: boolean;
    /** True until the first resolution (REST response or WS frame) arrives. */
    isLoading: boolean;
    /**
     * Variant identifier for multi-variant flags (e.g. 'control', 'variant-a',
     * 'variant-b'). Undefined for simple boolean flags.
     */
    variant?: string;
    /** Arbitrary metadata attached to the flag (e.g. rollout percentage, tier). */
    metadata?: Record<string, unknown>;
}
/**
 * Subscribe to a feature flag. Updates reactively when the flag value changes
 * via the gateway's flag broadcast channel.
 *
 * Falls back to `defaultValue` when:
 *   - no REST surface is wired, or
 *   - the gateway's `/api/feature-flags` endpoint is not yet available (404).
 *
 * Different from `useCapability`:
 *   - `useCapability`: CRD-derived, infrastructure-level — does this app have
 *     the 'chat' capability provisioned?
 *   - `useFeatureFlag`: app-level boolean/variant — should this user see the
 *     new UI, which A/B variant to serve, is a kill-switch active?
 *
 * @param name         - Flag identifier, e.g. 'new-checkout-ui'.
 * @param defaultValue - Value to use while loading or when the flag is unavailable.
 *                       Defaults to `false`.
 *
 * @example
 * ```tsx
 * // Boolean toggle
 * const { enabled, isLoading } = useFeatureFlag('new-checkout-ui');
 * if (isLoading) return <Spinner />;
 * return enabled ? <NewCheckout /> : <LegacyCheckout />;
 *
 * // Variant pattern
 * const { variant } = useFeatureFlag('checkout-flow', false);
 * if (variant === 'variant-a') return <CheckoutFlowA />;
 * if (variant === 'variant-b') return <CheckoutFlowB />;
 * return <CheckoutFlowControl />;
 * ```
 */
export declare function useFeatureFlag(name: string, defaultValue?: boolean): UseFeatureFlagResult;
//# sourceMappingURL=useFeatureFlag.d.ts.map