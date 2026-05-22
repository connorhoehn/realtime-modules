"use strict";
// realtime-modules/src/client/useCapability.ts
//
// useCapability(name, channel?) — discovers whether a named capability CRD
// is provisioned for the current user/context and surfaces it as a typed
// descriptor so apps can render conditionally.
//
// Usage:
//   const { enabled } = useCapability('chat');
//   if (!enabled) return <ChatNotAvailable />;
//   return <ChatPanel />;
//
// Design:
//   1. Queries `GatewayContextValue.rest?.getCapability?.(name, channel)` if the
//      proxy-client REST surface is available (Lambda / non-WS callers).
//   2. Falls back to optimistic enabled=true when the gateway hasn't shipped the
//      /api/capabilities endpoint yet (404 → ProxyClientHttpError with status 404)
//      or when no REST surface is wired (null/undefined).
//   3. Also listens for `capability:updated` push frames from the server so state
//      updates without a full remount when the control-plane mutates a CRD.
//
// On gateway side, capabilities are derived from registered CRDs flowing
// through ControlPlaneChannel. When the /api/capabilities route is not yet
// available the hook uses an optimistic-enabled default so existing UI code
// keeps working without gating on the new endpoint.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useCapability = useCapability;
const react_1 = require("react");
const GatewaySocketProvider_1 = require("./GatewaySocketProvider");
// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
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
function useCapability(name, channel) {
    const gateway = (0, GatewaySocketProvider_1.useGateway)();
    const [capability, setCapability] = (0, react_1.useState)(null);
    const [isLoading, setIsLoading] = (0, react_1.useState)(true);
    const [error, setError] = (0, react_1.useState)(undefined);
    // Fetch initial capability state and subscribe to push updates.
    (0, react_1.useEffect)(() => {
        let cancelled = false;
        async function fetchCapability() {
            try {
                // The GatewayContextValue may optionally carry a `rest` shim (e.g.
                // GatewayProxyClient) for Lambda-tier callers. The getCapability method
                // is not yet shipped on the gateway, so we guard both the field and the
                // method with optional-chaining.
                //
                // Typed as `unknown` because GatewayContextValue doesn't declare `rest`
                // — it's an extension point that Lambda consumers wire in via context
                // override. We access it via `(gateway as any).rest` so we don't
                // introduce a hard dependency on proxy-client types in this hook.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const rest = gateway.rest;
                let resolved;
                if (typeof rest?.getCapability === 'function') {
                    try {
                        const response = await rest.getCapability(name, channel);
                        resolved = {
                            name,
                            enabled: response.enabled,
                            channel,
                            version: response.version,
                            metadata: response.metadata,
                        };
                    }
                    catch (err) {
                        // 404 → gateway doesn't expose /api/capabilities yet; fall back to
                        // optimistic enabled=true so existing UI keeps working.
                        const status = err.status;
                        if (status === 404) {
                            resolved = { name, enabled: true, channel };
                        }
                        else {
                            throw err;
                        }
                    }
                }
                else {
                    // No REST surface wired — optimistic enabled=true.
                    resolved = { name, enabled: true, channel };
                }
                if (!cancelled) {
                    setCapability(resolved);
                    setIsLoading(false);
                }
            }
            catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err : new Error(String(err)));
                    setIsLoading(false);
                }
            }
        }
        fetchCapability();
        // Also listen for capability:updated push frames from the gateway control
        // plane so state updates without a remount when a CRD is toggled.
        const off = gateway.onMessage((frame) => {
            const raw = frame;
            if (raw['type'] !== 'capability:updated')
                return;
            const payload = raw['payload'];
            if (!payload || payload.name !== name)
                return;
            // Scope guard: if a channel was specified, only accept matching frames.
            if (channel !== undefined && payload.channel !== channel)
                return;
            setCapability({
                name: payload.name,
                enabled: payload.enabled,
                channel: payload.channel,
                version: payload.version,
                metadata: payload.metadata,
            });
            // Once a frame arrives we are no longer loading.
            setIsLoading(false);
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [gateway, name, channel]);
    return {
        capability,
        enabled: capability?.enabled ?? false,
        isLoading,
        error,
    };
}
//# sourceMappingURL=useCapability.js.map