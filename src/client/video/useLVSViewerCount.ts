// How many people are watching.
//
// The one number a broadcast is actually about. A stream to a mass audience
// with no audience figure is a video call with extra steps: the person
// presenting cannot tell whether ten people or none are on the other side, and
// a viewer cannot tell whether they have joined something live or are alone in
// an empty room.
//
// LVS tracks it (`GET /api/channels/:arn/viewers` → `{concurrent_viewers}`) and
// nothing in the stack was asking. StreamStage has taken a `viewerCount` prop
// the entire time and no caller ever supplied one.
//
// Polled rather than pushed: the count is a soft number that is interesting at
// human resolution, and a WebSocket per viewer purely to animate a counter
// would cost more than the thing it reports.

import { useEffect, useRef, useState } from 'react';
import { useSafeLVSContext } from './LVSProvider';

export interface UseLVSViewerCountOptions {
  /** Channel to count. Null is idle — no request is made. */
  channelArn: string | null;
  /** How often to re-ask, in ms. Default 15s. */
  intervalMs?: number;
  /** Override base URL (else pulled from LVSProvider). */
  baseUrl?: string;
  /** Playback JWT for private channels. */
  playbackToken?: string | null;
}

export interface UseLVSViewerCountResult {
  /**
   * Concurrent viewers, or null when it is not known.
   *
   * Null and 0 are DIFFERENT and callers must not collapse them: 0 is "nobody
   * is watching", null is "we have not been told". Rendering an unknown count
   * as `0 watching` invents a fact, and on a stream that is working it is the
   * most discouraging possible thing to show the person presenting.
   */
  viewerCount: number | null;
  /** Last failure, or null. Never thrown — a counter must not take a page down. */
  error: Error | null;
}

export function useLVSViewerCount({
  channelArn,
  intervalMs = 15_000,
  baseUrl: baseUrlOpt,
  playbackToken,
}: UseLVSViewerCountOptions): UseLVSViewerCountResult {
  const ctx = useSafeLVSContext();
  const baseUrl = baseUrlOpt ?? ctx?.baseUrl ?? '';
  const [viewerCount, setViewerCount] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const tokenRef = useRef(playbackToken);
  tokenRef.current = playbackToken;

  useEffect(() => {
    // A channel that changed must not keep showing the previous one's audience.
    setViewerCount(null);
    setError(null);
    if (!channelArn || !baseUrl) return;

    let cancelled = false;
    const url =
      `${baseUrl.replace(/\/$/, '')}/api/channels/${encodeURIComponent(channelArn)}/viewers`;

    const poll = async () => {
      try {
        const res = await fetch(url, {
          headers: tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : undefined,
        });
        if (cancelled) return;
        if (!res.ok) {
          // 503 means LVS has no viewer tracker configured. That is "unknown",
          // not "zero" — leave the count null so the UI stays quiet rather
          // than reporting an empty house.
          setViewerCount(null);
          return;
        }
        const body = (await res.json()) as { concurrent_viewers?: unknown };
        if (cancelled) return;
        setViewerCount(
          typeof body.concurrent_viewers === 'number' ? body.concurrent_viewers : null,
        );
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setViewerCount(null);
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    void poll();
    const timer = setInterval(() => { void poll(); }, Math.max(2000, intervalMs));
    return () => { cancelled = true; clearInterval(timer); };
  }, [channelArn, baseUrl, intervalMs]);

  return { viewerCount, error };
}
