/**
 * @jest-environment jsdom
 */
import { renderHook } from '@testing-library/react';
import { useLVSLiveHls } from '../../src/client/video/useLVSLiveHls';

// The many-viewers half of LVS. Its sibling useLVSHlsPlayer composes a DVR
// window (`from`/`to`) and so cannot express "right now" — which is why a live
// broadcast had no hook and every consumer hand-built the URL.

const ARN = 'arn:local:ivs:channel/abc-123';
const BASE = 'http://lvs.test';

const url = (opts: Parameters<typeof useLVSLiveHls>[0]) =>
  renderHook(() => useLVSLiveHls(opts)).result.current;

describe('useLVSLiveHls', () => {
  it('composes the live playlist for a channel', () => {
    const r = url({ channelArn: ARN, baseUrl: BASE });
    expect(r.ready).toBe(true);
    expect(r.playlistUrl).toBe(
      `${BASE}/api/channels/${encodeURIComponent(ARN)}/hls/master.m3u8`,
    );
  });

  // An audience is on every network there is; dropping a rung beats stalling.
  it('asks for the ABR master by default', () => {
    expect(url({ channelArn: ARN, baseUrl: BASE }).playlistUrl).toContain('master.m3u8');
  });

  it('can pin a single rendition', () => {
    const r = url({ channelArn: ARN, baseUrl: BASE, abr: false });
    expect(r.playlistUrl).toContain('playlist.m3u8');
    expect(r.playlistUrl).not.toContain('master.m3u8');
  });

  // The ARN contains slashes and colons.
  it('encodes the ARN into the path', () => {
    const r = url({ channelArn: ARN, baseUrl: BASE });
    expect(r.playlistUrl).not.toContain('arn:local');
    expect(r.playlistUrl).toContain(encodeURIComponent(ARN));
  });

  it('carries a playback token for a private channel', () => {
    const r = url({ channelArn: ARN, baseUrl: BASE, playbackToken: 'tok en/+' });
    expect(r.playlistUrl).toContain(`?token=${encodeURIComponent('tok en/+')}`);
  });

  it('adds no query string for a public channel', () => {
    expect(url({ channelArn: ARN, baseUrl: BASE }).playlistUrl).not.toContain('?');
  });

  // No channel yet is the normal pre-broadcast state, not an error.
  it('is idle without a channel', () => {
    const r = url({ channelArn: null, baseUrl: BASE });
    expect(r.ready).toBe(false);
    expect(r.playlistUrl).toBeNull();
  });

  it('is idle without a base url', () => {
    expect(url({ channelArn: ARN, baseUrl: '' }).ready).toBe(false);
  });

  // A live viewer keeps a tab open for an hour; the token outliving the
  // session is the difference between a stream and a network error.
  it('reports no expiry when there is no token', () => {
    expect(url({ channelArn: ARN, baseUrl: BASE }).tokenExpiresInSec).toBeNull();
  });

  it('reports seconds remaining for a token that has an exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const jwt = `x.${btoa(JSON.stringify({ exp })).replace(/=+$/, '')}.y`;
    const left = url({ channelArn: ARN, baseUrl: BASE, playbackToken: jwt }).tokenExpiresInSec;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(600);
  });
});
