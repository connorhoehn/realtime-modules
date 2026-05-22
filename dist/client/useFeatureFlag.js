"use strict";
// realtime-modules/src/client/useFeatureFlag.ts
//
// useFeatureFlag(name, defaultValue?) — app-level boolean/variant feature flag
// that updates reactively when the gateway broadcasts a flag-change frame.
//
// Usage:
//   const { enabled } = useFeatureFlag('new-ui');
//   if (!enabled) return <OldUI />;
//   return <NewUI />;
//
//   // Variant pattern
//   const { variant } = useFeatureFlag('checkout-flow');
//   if (variant === 'variant-a') return <CheckoutFlowA />;
//   if (variant === 'variant-b') return <CheckoutFlowB />;
//   return <CheckoutFlowControl />;
//
// Design:
//   1. Queries `GatewayContextValue.rest?.getFeatureFlag?.(name)` when the
//      proxy-client REST surface is wired (Lambda / non-WS callers).
//   2. Falls back gracefully to `defaultValue` when the endpoint 404s or when
//      no REST surface is available — the gateway's /api/feature-flags route
//      has not yet landed; this hook is forward-compatible once it ships.
//   3. Listens for `feature-flag:updated` push frames from the gateway so state
//      updates reactively without a full remount when a flag value changes.
//
// Different from useCapability:
//   - useCapability: CRD-derived, infrastructure-level (does this app have
//     the 'chat' capability provisioned?).
//   - useFeatureFlag: app-level boolean/variant (should THIS user see the new
//     UI? which A/B variant should be served? kill-switch active?).
Object.defineProperty(exports, "__esModule", { value: true });
exports.useFeatureFlag = useFeatureFlag;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
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
function useFeatureFlag(name, defaultValue = false) {
    const gateway = (0, GatewaySocketProvider_1.useGateway)();
    const [state, setState] = (0, react_1.useState)({
        enabled: defaultValue,
        isLoading: true,
    });
    (0, react_1.useEffect)(() => {
        let cancelled = false;
        async function fetchFlag() {
            try {
                // GatewayContextValue does not declare a `rest` field directly — it is
                // an extension point wired by Lambda-tier consumers (e.g. OrgIQ) via a
                // context override. Access it through an unknown cast identical to the
                // pattern in useCapability.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const rest = gateway.rest;
                if (typeof rest?.getFeatureFlag === 'function') {
                    try {
                        const result = await rest.getFeatureFlag(name);
                        if (!cancelled) {
                            setState({
                                enabled: result.enabled,
                                variant: result.variant,
                                metadata: result.metadata,
                                isLoading: false,
                            });
                        }
                    }
                    catch (err) {
                        // 404 → endpoint not yet shipped; fall back to defaultValue.
                        // Any other error also falls back silently so the hook degrades
                        // gracefully for kill-switch / A/B use-cases.
                        if (!cancelled) {
                            setState({ enabled: defaultValue, isLoading: false });
                        }
                    }
                }
                else {
                    // No REST surface wired — use defaultValue immediately.
                    if (!cancelled) {
                        setState({ enabled: defaultValue, isLoading: false });
                    }
                }
            }
            catch {
                if (!cancelled) {
                    setState({ enabled: defaultValue, isLoading: false });
                }
            }
        }
        fetchFlag();
        // Subscribe to flag-update broadcasts from the gateway so state refreshes
        // reactively when the control plane mutates a flag (e.g. kill-switch,
        // gradual rollout percentage change).
        const off = gateway.onMessage((frame) => {
            const raw = frame;
            if (raw['type'] !== 'feature-flag:updated')
                return;
            const payload = raw['payload'];
            if (!payload || payload.name !== name)
                return;
            setState({
                enabled: payload.enabled,
                variant: payload.variant,
                metadata: payload.metadata,
                isLoading: false,
            });
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [gateway, name, defaultValue]);
    return state;
}
//# sourceMappingURL=useFeatureFlag.js.map