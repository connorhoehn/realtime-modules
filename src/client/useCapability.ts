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

import { useState, useEffect } from 'react';
import { useGateway } from './GatewaySocketProvider';
import type { GatewayMessage } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Shape of the REST response from /api/capabilities
// ---------------------------------------------------------------------------

interface CapabilityRestResponse {
  enabled: boolean;
  version?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Shape of a capability:updated WS frame payload
// ---------------------------------------------------------------------------

interface CapabilityUpdatedPayload {
  name: string;
  enabled: boolean;
  channel?: string;
  version?: string;
  metadata?: Record<string, unknown>;
}

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
export function useCapability(name: string, channel?: string): UseCapabilityResult {
  const gateway = useGateway();

  const [capability, setCapability] = useState<CapabilityDescriptor | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);

  // Fetch initial capability state and subscribe to push updates.
  useEffect(() => {
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
        const rest = (gateway as unknown as { rest?: unknown }).rest as
          | { getCapability?: (n: string, ch?: string) => Promise<CapabilityRestResponse> }
          | undefined;

        let resolved: CapabilityDescriptor;

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
          } catch (err: unknown) {
            // 404 → gateway doesn't expose /api/capabilities yet; fall back to
            // optimistic enabled=true so existing UI keeps working.
            const status = (err as { status?: number }).status;
            if (status === 404) {
              resolved = { name, enabled: true, channel };
            } else {
              throw err;
            }
          }
        } else {
          // No REST surface wired — optimistic enabled=true.
          resolved = { name, enabled: true, channel };
        }

        if (!cancelled) {
          setCapability(resolved);
          setIsLoading(false);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      }
    }

    fetchCapability();

    // Also listen for capability:updated push frames from the gateway control
    // plane so state updates without a remount when a CRD is toggled.
    const off = gateway.onMessage((frame: GatewayMessage) => {
      const raw = frame as unknown as Record<string, unknown>;
      if (raw['type'] !== 'capability:updated') return;

      const payload = raw['payload'] as CapabilityUpdatedPayload | undefined;
      if (!payload || payload.name !== name) return;
      // Scope guard: if a channel was specified, only accept matching frames.
      if (channel !== undefined && payload.channel !== channel) return;

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
