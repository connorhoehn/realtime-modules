// useLVSLiveHls — the LIVE half of HLS playback.
//
// ## Why this is separate from useLVSHlsPlayer
//
// That hook composes `/dvr/playlist.m3u8?from=…&to=…`: a TIME WINDOW of a
// recording. It cannot express "what is happening right now" — the window is
// required, and a live viewer has no end time. So the many-viewers broadcast
// case had no hook at all: LVS served `/hls/playlist.m3u8`, and every consumer
// that wanted to watch a live stream had to hand-build the URL.
//
// ## Which transport to use, and why it is a real choice
//
// LVS can deliver the same channel two ways, and they are not
// interchangeable:
//
//   REALTIME (WHEP, `useLVSSubscriber`) — sub-second glass-to-glass, one
//     peer connection per viewer. That per-viewer cost is the point and the
//     limit: it is what makes a CALL work and what makes a thousand-viewer
//     broadcast expensive.
//
//   NEAR-REALTIME (HLS, this hook) — segmented over plain HTTP, so it is
//     cacheable and a CDN can carry it to an audience of any size. The price
//     is latency: a few seconds, set by segment duration.
//
// Rule of thumb: if viewers TALK BACK, they need realtime. If they watch,
// near-realtime is cheaper by orders of magnitude and looks identical.
//
// Like its DVR sibling this is a pure URL composer — no DOM, no player. Hand
// `playlistUrl` to <StreamStage playlistUrl=…> (ui-components), which owns
// the hls.js/native-Safari branch.

import { useMemo } from 'react';
import { useSafeLVSContext } from './LVSProvider';
import { jwtSecondsRemaining } from './lib/jwt';

export interface UseLVSLiveHlsOptions {
  /** Channel ARN to watch. Null = idle, which is the pre-broadcast state. */
  channelArn: string | null;
  /**
   * Ask for the ABR master playlist rather than a single rendition.
   *
   * Default true: an audience is on every network there is, and the whole
   * reason to choose HLS is that the player can drop a rung instead of
   * stalling. Set false to pin one rendition (a kiosk on a known link).
   */
  abr?: boolean;
  /** Playback JWT for private channels. Public channels need none. */
  playbackToken?: string | null;
  /** Override base URL (else pulled from LVSProvider). */
  baseUrl?: string;
}

export interface UseLVSLiveHlsResult {
  /** Ready-to-play playlist URL, or null when inputs are incomplete. */
  playlistUrl: string | null;
  /**
   * Seconds until the playback token expires — Infinity when the token has no
   * exp claim, null when there is no token.
   *
   * Live playback outlives a token far more often than VOD does: a viewer
   * leaves a broadcast open for an hour. Refresh BEFORE this reaches zero, or
   * the stream dies mid-segment with a network error that looks like a
   * broken stream rather than an expired credential.
   */
  tokenExpiresInSec: number | null;
  /** True when a URL could be produced. */
  ready: boolean;
}

export function useLVSLiveHls(opts: UseLVSLiveHlsOptions): UseLVSLiveHlsResult {
  const ctx = useSafeLVSContext();
  const baseUrl = opts.baseUrl ?? ctx?.baseUrl ?? '';
  const { channelArn, playbackToken, abr = true } = opts;

  return useMemo(() => {
    if (!channelArn || !baseUrl) {
      return { playlistUrl: null, tokenExpiresInSec: null, ready: false };
    }
    // `master.m3u8` is the ABR entry point; `playlist.m3u8` is the single
    // rendition. LVS serves master through playlist.m3u8 too when ABR is on,
    // but asking for the one we mean keeps the intent readable in a network
    // log — and correct if that aliasing ever changes.
    const file = abr ? 'master.m3u8' : 'playlist.m3u8';
    const qs = playbackToken ? `?token=${encodeURIComponent(playbackToken)}` : '';
    const playlistUrl =
      `${baseUrl}/api/channels/${encodeURIComponent(channelArn)}/hls/${file}${qs}`;

    return {
      playlistUrl,
      tokenExpiresInSec: playbackToken ? jwtSecondsRemaining(playbackToken) : null,
      ready: true,
    };
  }, [channelArn, playbackToken, abr, baseUrl]);
}
