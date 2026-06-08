import * as React from 'react';
import { type UseLVSHangoutOptions, type UseLVSHangoutResult } from './useLVSHangout';
/**
 * React context carrying the shared useLVSHangout session. Most callers
 * should not read this directly — use {@link useLVSHangoutShared}
 * instead. Exposed mostly for advanced consumers (custom providers,
 * tests).
 */
export declare const LVSHangoutSessionContext: React.Context<UseLVSHangoutResult | null>;
export interface LVSHangoutSessionProviderProps {
    /** Options forwarded to the underlying useLVSHangout call. */
    opts: UseLVSHangoutOptions;
    children?: React.ReactNode;
}
/**
 * Provider that mounts useLVSHangout ONCE at its boundary so multiple
 * downstream consumers share the same session — one WS subscription,
 * one set of WHEP PCs, one camera stream.
 */
export declare function LVSHangoutSessionProvider({ opts, children }: LVSHangoutSessionProviderProps): React.ReactElement;
/**
 * Read the shared useLVSHangout session from context. Throws when
 * called outside {@link LVSHangoutSessionProvider}.
 *
 * The returned value is the SAME object as the underlying
 * useLVSHangout(opts) at the provider boundary — every getter,
 * callback, and ref is identical across all consumers. No additional
 * WS subscription is opened per consumer.
 */
export declare function useLVSHangoutShared(): UseLVSHangoutResult;
//# sourceMappingURL=useLVSHangoutShared.d.ts.map