// useLVSHangoutShared — context-shared variant of useLVSHangout.
//
// Multiple consumers of the SAME (channelArn, participantId) all receive
// the same UseLVSHangoutResult — one WS subscription, one set of WHEP
// PCs, one camera stream — rather than each opening its own discovery
// connection. Closes the duplicate-subscription cost confirmed in the
// 2026-06-04 gateway demo (memory: uselvshangout_shared_followup).
//
// Usage:
//
//   <LVSHangoutSessionProvider opts={{ stageToken, participantId, ... }}>
//     <ComponentA />  {/* uses useLVSHangoutShared() */}
//     <ComponentB />  {/* uses useLVSHangoutShared() */}
//   </LVSHangoutSessionProvider>
//
// All consumers receive the same value. The provider mounts the
// underlying useLVSHangout ONCE at its boundary; React's normal
// memoization carries the result to children. To re-key the session
// (different participant or different token), pass a `key` prop on
// the provider derived from the identity tuple so React re-mounts it
// cleanly.
//
// Migration: any consumer that currently calls useLVSHangout(opts) can
// be moved under a single shared provider and swap to
// useLVSHangoutShared() with no API change — the returned shape is
// identical (it IS the same value).

import * as React from 'react';
import { useLVSHangout, type UseLVSHangoutOptions, type UseLVSHangoutResult } from './useLVSHangout';

/**
 * React context carrying the shared useLVSHangout session. Most callers
 * should not read this directly — use {@link useLVSHangoutShared}
 * instead. Exposed mostly for advanced consumers (custom providers,
 * tests).
 */
export const LVSHangoutSessionContext = React.createContext<UseLVSHangoutResult | null>(null);

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
export function LVSHangoutSessionProvider({ opts, children }: LVSHangoutSessionProviderProps): React.ReactElement {
  const session = useLVSHangout(opts);
  return React.createElement(
    LVSHangoutSessionContext.Provider,
    { value: session },
    children,
  );
}

/**
 * Read the shared useLVSHangout session from context. Throws when
 * called outside {@link LVSHangoutSessionProvider}.
 *
 * The returned value is the SAME object as the underlying
 * useLVSHangout(opts) at the provider boundary — every getter,
 * callback, and ref is identical across all consumers. No additional
 * WS subscription is opened per consumer.
 */
export function useLVSHangoutShared(): UseLVSHangoutResult {
  const session = React.useContext(LVSHangoutSessionContext);
  if (!session) {
    throw new Error(
      'useLVSHangoutShared() must be called inside <LVSHangoutSessionProvider>. If a single consumer needs its own session, use useLVSHangout() directly.',
    );
  }
  return session;
}
