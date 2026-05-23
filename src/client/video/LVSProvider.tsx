// LVSProvider — React context for LVS (live-video-streaming) configuration.
// Hooks downstream (useLVSPublisher / useLVSSubscriber / useLVSHangout)
// read baseUrl + auth-token from here. Mirrors GatewaySocketProvider's
// shape so consumers see a familiar context surface.

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

export type LogLevel = 'info' | 'warn' | 'err' | 'ok';
export type LVSLog = (msg: string, level?: LogLevel) => void;

export interface LVSConfig {
  /** Base URL of the SFU. WHIP/WHEP URLs are derived as
   *  `${baseUrl}/api/channels/:arn/{whip|whep}`. Defaults to same-origin
   *  (empty string). */
  baseUrl: string;
  /** Per-request Bearer-token resolver. Called lazily so consumers can
   *  rotate tokens (refresh, multi-session). Must always resolve — even
   *  if the token is empty (some channels are public). */
  getAuthToken: () => string | Promise<string>;
  /** Structured logger, defaults to console.* by level. Pass a no-op
   *  to silence; pass a custom impl to forward to your telemetry. */
  log: LVSLog;
}

export interface LVSProviderProps {
  baseUrl?: string;
  getAuthToken: () => string | Promise<string>;
  log?: LVSLog;
  children: ReactNode;
}

const LVSContext = createContext<LVSConfig | null>(null);

function defaultLog(msg: string, level: LogLevel = 'info'): void {
  const tag = '[lvs]';
  if (level === 'err') console.error(tag, msg);
  else if (level === 'warn') console.warn(tag, msg);
  else console.log(tag, msg);
}

export function LVSProvider({ baseUrl, getAuthToken, log, children }: LVSProviderProps) {
  const value = useMemo<LVSConfig>(() => ({
    baseUrl: baseUrl ?? '',
    getAuthToken,
    log: log ?? defaultLog,
  }), [baseUrl, getAuthToken, log]);
  return <LVSContext.Provider value={value}>{children}</LVSContext.Provider>;
}

/**
 * Read the LVSProvider's config. Throws an actionable error if the
 * caller is outside a provider. Hooks may also accept per-call overrides
 * (baseUrl + getAuthToken) and fall back to this context when omitted.
 */
export function useLVSContext(): LVSConfig {
  const ctx = useContext(LVSContext);
  if (!ctx) {
    throw new Error(
      '[lvs] useLVSContext called outside <LVSProvider>. Wrap your app in <LVSProvider baseUrl="..." getAuthToken={...}> or pass baseUrl + getAuthToken directly to the hook.',
    );
  }
  return ctx;
}

/**
 * Non-throwing variant of {@link useLVSContext}: returns null when the
 * caller is outside a provider. Hooks that accept full opts overrides
 * (baseUrl + getAuthToken) should use this so the provider becomes
 * truly optional — avoids the try/catch-around-useContext pattern that
 * each hook used to duplicate (audit P0).
 */
export function useSafeLVSContext(): LVSConfig | null {
  return useContext(LVSContext);
}

/**
 * Internal helper for hooks: resolve the effective config by overlaying
 * per-call options on top of the provider context. Returns null if the
 * caller didn't pass overrides AND there's no provider — letting hooks
 * gracefully fall back to opt-in behavior.
 */
export function resolveLVSConfig(opts: {
  baseUrl?: string;
  getAuthToken?: () => string | Promise<string>;
  log?: LVSLog;
}): LVSConfig | null {
  // Note: this is called inside hooks. We can't conditionally call
  // useContext, but consumers can pass `null` for ctx via try/catch.
  // The caller (a hook) will wrap useLVSContext in try/catch + use this.
  if (opts.baseUrl !== undefined && opts.getAuthToken) {
    return {
      baseUrl: opts.baseUrl,
      getAuthToken: opts.getAuthToken,
      log: opts.log ?? defaultLog,
    };
  }
  return null;
}
