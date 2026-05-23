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
export declare function LVSProvider({ baseUrl, getAuthToken, log, children }: LVSProviderProps): import("react/jsx-runtime").JSX.Element;
/**
 * Read the LVSProvider's config. Throws an actionable error if the
 * caller is outside a provider. Hooks may also accept per-call overrides
 * (baseUrl + getAuthToken) and fall back to this context when omitted.
 */
export declare function useLVSContext(): LVSConfig;
/**
 * Internal helper for hooks: resolve the effective config by overlaying
 * per-call options on top of the provider context. Returns null if the
 * caller didn't pass overrides AND there's no provider — letting hooks
 * gracefully fall back to opt-in behavior.
 */
export declare function resolveLVSConfig(opts: {
    baseUrl?: string;
    getAuthToken?: () => string | Promise<string>;
    log?: LVSLog;
}): LVSConfig | null;
//# sourceMappingURL=LVSProvider.d.ts.map