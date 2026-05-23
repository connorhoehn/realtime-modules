// useLVSHlsPlayer — pure URL composer for the LVS DVR HLS playback
// endpoint. Returns a ready-to-use playlist URL (m3u8) that consumers
// can hand to `<video src>` (Safari native HLS) or hls.js (everywhere
// else). No DOM manipulation — see <RecordingPlayer> in ui-components
// for the actual playback chrome.
//
// Auth flow: for PUBLIC channels (default), the playlist URL is open
// and `playbackToken` is unnecessary. For PRIVATE channels, callers
// pass a JWT minted by `POST /api/channels/:arn/playback-tokens` (or
// via the platform-api `/api/recordings/:id/playback-token` helper).
// The hook adds `?token=<jwt>` to the URL transparently.
//
// JWT expiry: we decode the token's exp claim and surface `expiresAt`
// so consumers can refresh BEFORE the URL stops working (HLS players
// will fail mid-playback if the token expires while a segment is in
// flight). For simple cases, mint a fresh token before each playback
// session and ignore the refresh.

import { useMemo } from 'react';
import { useLVSContext, type LVSConfig } from './LVSProvider';
import { jwtSecondsRemaining } from './lib/jwt';

export interface UseLVSHlsPlayerOptions {
  /** Channel ARN — the recording's source channel. Null = idle. */
  channelArn: string | null;
  /** Time window for the DVR playlist. Required — LVS defaults are
   *  `now - 1h` / `now` which is rarely what consumers want. */
  fromIso: string | null;
  toIso: string | null;
  /** Optional playback JWT for private channels. */
  playbackToken?: string | null;
  /** Override base URL (else pulled from LVSProvider). */
  baseUrl?: string;
}

export interface UseLVSHlsPlayerResult {
  /** Ready-to-use HLS playlist URL, or null if inputs are incomplete. */
  playlistUrl: string | null;
  /** Seconds until the playback token expires (Infinity if no exp claim,
   *  null if no token). Consumers use this to refresh before playback. */
  tokenExpiresInSec: number | null;
  /** True when inputs are present and a URL can be produced. */
  ready: boolean;
}

function useSafeLVSContext(): LVSConfig | null {
  try { return useLVSContext(); } catch { return null; }
}

export function useLVSHlsPlayer(opts: UseLVSHlsPlayerOptions): UseLVSHlsPlayerResult {
  const ctx = useSafeLVSContext();
  const baseUrl = opts.baseUrl ?? ctx?.baseUrl ?? '';

  return useMemo(() => {
    if (!opts.channelArn || !opts.fromIso || !opts.toIso || !baseUrl) {
      return { playlistUrl: null, tokenExpiresInSec: null, ready: false };
    }
    const params = new URLSearchParams({
      from: opts.fromIso,
      to: opts.toIso,
    });
    if (opts.playbackToken) params.set('token', opts.playbackToken);
    const playlistUrl = `${baseUrl}/api/channels/${encodeURIComponent(opts.channelArn)}/dvr/playlist.m3u8?${params}`;

    const tokenExpiresInSec = opts.playbackToken
      ? jwtSecondsRemaining(opts.playbackToken)
      : null;

    return { playlistUrl, tokenExpiresInSec, ready: true };
  }, [opts.channelArn, opts.fromIso, opts.toIso, opts.playbackToken, baseUrl]);
}
