/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useLVSHangout.test.tsx
//
// Regression coverage for the React-StrictMode double-subscribe bug
// (epoch-keyed openPcFor) and the same-kind track eviction landed in
// 9df5dab.
//
// Covers:
//   - StrictMode mounts the discovery-WS effect twice; only ONE
//     RTCPeerConnection is opened per remote producer.
//   - in-flight openPcFor is cancelled by fast cleanup BEFORE its
//     async whepPublish resolves, so no stray PC ends up in
//     remoteSubscribersRef after teardown.
//   - same-kind track eviction (the 9df5dab fix): a second video
//     track for the same remote replaces the first instead of
//     accumulating; the older track is stopped.
//   - discovery-WS reconnect ladder fires on unexpected close.

import React from 'react';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, render } from '@testing-library/react';

// jsdom doesn't ship MediaStream — install a minimal polyfill BEFORE
// importing the hook (the hook references MediaStream at module-eval
// time via type-only imports, but a runtime `new MediaStream()` in
// onTrack would also need this).
class FakeMediaStream {
  id: string;
  private _tracks: Array<{ id: string; kind: string; readyState: string; enabled: boolean; stop: () => void; addEventListener: (e: string, cb: () => void) => void }>;
  constructor() {
    this.id = `stream-${Math.random().toString(36).slice(2, 9)}`;
    this._tracks = [];
  }
  getTracks() { return this._tracks; }
  getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio'); }
  getVideoTracks() { return this._tracks.filter((t) => t.kind === 'video'); }
  addTrack(t: { id: string; kind: string; readyState: string; enabled: boolean; stop: () => void; addEventListener: (e: string, cb: () => void) => void }) {
    if (!this._tracks.some((x) => x.id === t.id)) this._tracks.push(t);
  }
  removeTrack(t: { id: string }) {
    this._tracks = this._tracks.filter((x) => x.id !== t.id);
  }
}
(globalThis as unknown as { MediaStream: unknown }).MediaStream = FakeMediaStream;

import { useLVSHangout } from '../../src/client/video/useLVSHangout';

// ---------------------------------------------------------------------------
// JWT helper — encode an `arn` claim so decodeArn() returns a non-null
// channelArn (without this, the hook idles and no PC opens).
// ---------------------------------------------------------------------------

function makeToken(arn: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ arn })).toString('base64url');
  return `${header}.${body}.`;
}

// ---------------------------------------------------------------------------
// Mocks: RTCPeerConnection
// ---------------------------------------------------------------------------

interface FakeTrack {
  id: string;
  kind: 'audio' | 'video';
  readyState: 'live' | 'ended';
  enabled: boolean;
  stop: jest.Mock;
  addEventListener: jest.Mock;
  _endedListeners: Array<() => void>;
}

let pcInstances: FakePeerConnection[] = [];

class FakePeerConnection {
  iceServers: unknown[];
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  iceGatheringState: 'new' | 'gathering' | 'complete' = 'complete';
  signalingState = 'stable';
  closed = false;
  receivers: Array<{ track: FakeTrack }> = [];
  trackListeners: Array<(ev: { track: FakeTrack; streams: MediaStream[] }) => void> = [];
  gatheringStateListeners: Array<() => void> = [];
  closeMock = jest.fn();

  constructor(config: { iceServers?: unknown[] } = {}) {
    this.iceServers = config.iceServers ?? [];
    pcInstances.push(this);
  }

  isRecvOnly = false;
  addTransceiver = jest.fn((kind: string, init?: { direction?: string }) => {
    if (init?.direction === 'recvonly') this.isRecvOnly = true;
    void kind;
  });
  addEventListener = jest.fn((evt: string, cb: unknown) => {
    if (evt === 'track') this.trackListeners.push(cb as never);
    if (evt === 'icegatheringstatechange') this.gatheringStateListeners.push(cb as never);
  });
  removeEventListener = jest.fn();
  createOffer = jest.fn(async () => ({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF\r\n' }));
  setLocalDescription = jest.fn(async (desc: { type: string; sdp: string }) => {
    this.localDescription = desc;
  });
  setRemoteDescription = jest.fn(async (desc: { type: string; sdp: string }) => {
    this.remoteDescription = desc;
  });
  getReceivers = () => this.receivers;
  close = () => {
    this.closed = true;
    this.closeMock();
  };

  // Test helper: drive an onTrack event into the hook.
  emitTrack(kind: 'audio' | 'video', trackId: string, streamId: string): FakeTrack {
    const track: FakeTrack = {
      id: trackId,
      kind,
      readyState: 'live',
      enabled: true,
      stop: jest.fn(function (this: FakeTrack) { this.readyState = 'ended'; }),
      _endedListeners: [],
      addEventListener: jest.fn(function (this: FakeTrack, evt: string, cb: () => void) {
        if (evt === 'ended') this._endedListeners.push(cb);
      }) as jest.Mock,
    };
    // Bind `this` of stop properly.
    track.stop = jest.fn(() => { track.readyState = 'ended'; });
    track.addEventListener = jest.fn((evt: string, cb: () => void) => {
      if (evt === 'ended') track._endedListeners.push(cb);
    }) as jest.Mock;

    this.receivers.push({ track });
    const stream = new (globalThis as unknown as { MediaStream: new () => MediaStream }).MediaStream();
    (stream as unknown as { addTrack: (t: FakeTrack) => void }).addTrack(track);
    Object.defineProperty(stream, 'id', { value: streamId, configurable: true });

    for (const cb of this.trackListeners) {
      cb({ track, streams: [stream] });
    }
    return track;
  }
}

// ---------------------------------------------------------------------------
// Mocks: WebSocket
// ---------------------------------------------------------------------------

let wsInstances: FakeWebSocket[] = [];

class FakeWebSocket {
  url: string;
  readyState = 0;
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  listeners: Record<string, Array<(ev: unknown) => void>> = {};
  sent: string[] = [];
  closed = false;
  closeMock = jest.fn();

  constructor(url: string) {
    this.url = url;
    wsInstances.push(this);
  }
  addEventListener = (evt: string, cb: (ev: unknown) => void) => {
    (this.listeners[evt] ||= []).push(cb);
  };
  removeEventListener = jest.fn();
  send = (data: string) => { this.sent.push(data); };
  close = () => {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.closeMock();
    // Mimic browser-ish close event (some implementations don't fire
    // close after explicit .close() in time but the hook's cleanup
    // guards on `cancelled` so reconnect won't fire here).
    setTimeout(() => {
      for (const cb of this.listeners.close ?? []) cb({});
    }, 0);
  };

  // Test helpers
  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN;
    for (const cb of this.listeners.open ?? []) cb({});
  }
  triggerMessage(payload: object) {
    for (const cb of this.listeners.message ?? []) cb({ data: JSON.stringify(payload) });
  }
  triggerCloseUnexpected() {
    this.readyState = FakeWebSocket.CLOSED;
    for (const cb of this.listeners.close ?? []) cb({});
  }
}

// ---------------------------------------------------------------------------
// Mocks: fetch (ICE servers + WHIP + WHEP)
// ---------------------------------------------------------------------------

// jsdom-safe Response factory — wraps either real Response (if
// available) or a minimal duck-typed shape that satisfies the fetch
// callers in lib/transport.ts (which read .ok, .status, .headers.get,
// .text(), .json()).
function makeResponse(body: string, init?: { status?: number; headers?: Record<string, string> }) {
  const status = init?.status ?? 200;
  const headers = init?.headers ?? {};
  if (typeof Response !== 'undefined') {
    try {
      return new Response(body, init);
    } catch { /* fall through */ }
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: {
      get: (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? null,
    },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

interface FetchHandle {
  calls: Array<{ url: string; init?: RequestInit }>;
  impl: unknown;
  whepCalls: Array<{ url: string }>;
  whepDeleteCalls: Array<{ url: string }>;
}

function installFetchMock(): FetchHandle {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const whepCalls: Array<{ url: string }> = [];
  const whepDeleteCalls: Array<{ url: string }> = [];
  let whepCount = 0;
  const impl = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/api/ice-servers')) {
      return makeResponse(JSON.stringify({ iceServers: [{ urls: 'stun:fake' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/whip')) {
      return makeResponse('v=0\r\n', {
        status: 201,
        headers: {
          'Content-Type': 'application/sdp',
          Location: '/whip/resource-1',
        },
      });
    }
    if (url.includes('/whep')) {
      if (init?.method === 'DELETE') {
        whepDeleteCalls.push({ url });
        return makeResponse('', { status: 200 });
      }
      whepCount += 1;
      whepCalls.push({ url });
      return makeResponse('v=0\r\n', {
        status: 201,
        headers: {
          'Content-Type': 'application/sdp',
          Location: `/whep/resource-${whepCount}`,
        },
      });
    }
    // Default: 404
    return makeResponse('', { status: 404 });
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = impl as unknown as typeof fetch;
  return { calls, impl, whepCalls, whepDeleteCalls };
}

// ---------------------------------------------------------------------------
// Mocks: navigator.mediaDevices.getUserMedia
// ---------------------------------------------------------------------------

function installMediaDevicesMock() {
  const fakeStream = new (globalThis as unknown as { MediaStream: new () => MediaStream }).MediaStream();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: jest.fn(async () => fakeStream),
      getDisplayMedia: jest.fn(async () => fakeStream),
    },
  });
  return fakeStream;
}

// ---------------------------------------------------------------------------
// Test harness component — exposes the hook result via a ref.
// ---------------------------------------------------------------------------

interface HarnessHandle {
  result: ReturnType<typeof useLVSHangout> | null;
}

function Harness({ token, pid, handle }: { token: string; pid: string; handle: HarnessHandle }) {
  const r = useLVSHangout({
    stageToken: token,
    participantId: pid,
    userId: 'me',
    baseUrl: 'http://localhost:3901',
  });
  handle.result = r;
  return null;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const origRTC = (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection;
const origWS = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
const origFetch = (globalThis as unknown as { fetch?: unknown }).fetch;

let fetchHandle: FetchHandle;

beforeEach(() => {
  pcInstances = [];
  wsInstances = [];
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePeerConnection;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  fetchHandle = installFetchMock();
  installMediaDevicesMock();
  // Silence noisy console.info from the hook.
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

function whepPcs(): FakePeerConnection[] {
  return pcInstances.filter((p) => p.isRecvOnly);
}

afterEach(() => {
  (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection = origRTC;
  (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWS;
  (globalThis as unknown as { fetch?: unknown }).fetch = origFetch;
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TOKEN = makeToken('arn:test:channel/abc');
const PID = 'me-pid-1';
const REMOTE_PID = 'hank-pid-1';

async function flush() {
  // Drain microtasks several times — the hook chains 4+ awaits before
  // installing into remoteSubscribersRef.
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

describe('useLVSHangout — StrictMode safety', () => {
  it('opens exactly ONE RTCPeerConnection per remote producer under StrictMode double-invoke', async () => {
    const handle: HarnessHandle = { result: null };

    await act(async () => {
      render(
        <React.StrictMode>
          <Harness token={TOKEN} pid={PID} handle={handle} />
        </React.StrictMode>,
      );
    });

    // StrictMode mounted the discovery-WS effect twice → cleanup ran
    // between → SECOND mount is the live one. We expect TWO WS to have
    // been constructed but only the second is currently open.
    expect(wsInstances.length).toBeGreaterThanOrEqual(2);
    const liveWs = wsInstances[wsInstances.length - 1]!;

    await act(async () => {
      liveWs.triggerOpen();
      liveWs.triggerMessage({
        type: 'producer.added',
        participantId: REMOTE_PID,
        kind: 'video',
      });
      // Also fire the audio half of the same producer — should NOT
      // open a second PC.
      liveWs.triggerMessage({
        type: 'producer.added',
        participantId: REMOTE_PID,
        kind: 'audio',
      });
      await flush();
    });

    // Exactly ONE WHEP (recvonly) PC for the remote producer.
    // StrictMode would have opened two without the epoch-keyed
    // in-flight guard. (Note: pcInstances also includes the publisher's
    // sendrecv WHIP PC, hence the whepPcs() filter.)
    const subs = whepPcs();
    expect(subs).toHaveLength(1);
    expect(subs[0]!.closed).toBe(false);
    // Exactly ONE WHEP POST hit the SFU.
    expect(fetchHandle.whepCalls.length).toBe(1);
  });

  it('cancels in-flight openPcFor when cleanup fires before whepPublish resolves', async () => {
    // Install a fetch mock where the WHEP call hangs until we release it.
    let releaseWhep: ((value: Response) => void) | null = null;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (jest.fn(async (url: string) => {
      if (url.includes('/api/ice-servers')) {
        return makeResponse(JSON.stringify({ iceServers: [] }), { status: 200 });
      }
      if (url.includes('/whep')) {
        return new Promise<Response>((res) => { releaseWhep = res; });
      }
      if (url.includes('/whip')) {
        return makeResponse('v=0', { status: 201, headers: { Location: '/whip/x' } });
      }
      return makeResponse('', { status: 404 });
    }) as unknown) as typeof fetch;

    const handle: HarnessHandle = { result: null };
    const { unmount } = render(
      <Harness token={TOKEN} pid={PID} handle={handle} />,
    );

    // First (and only) WS for non-StrictMode test.
    await act(async () => { await flush(); });
    const ws = wsInstances[wsInstances.length - 1]!;

    await act(async () => {
      ws.triggerOpen();
      ws.triggerMessage({ type: 'producer.added', participantId: REMOTE_PID, kind: 'video' });
      // Allow openPcFor to reach the whepPublish await but not past it.
      await flush();
    });

    // PC was created (ICE fetch + createOffer resolved) but whepPublish
    // is still pending.
    const subs = whepPcs();
    expect(subs.length).toBeGreaterThanOrEqual(1);
    const stalledPc = subs[0]!;
    expect(stalledPc.closed).toBe(false);
    expect(releaseWhep).not.toBeNull();

    // Tear down before whepPublish resolves.
    unmount();

    // Now release the stalled whepPublish — the cancelled flag should
    // cause the openPcFor body to bail and close the PC instead of
    // installing it into remoteSubscribersRef.
    await act(async () => {
      releaseWhep!(makeResponse('v=0', { status: 201, headers: { Location: '/whep/late' } }));
      await flush();
    });

    expect(stalledPc.closed).toBe(true);
  });

  it('evicts duplicate same-kind tracks (regression for 9df5dab)', async () => {
    const handle: HarnessHandle = { result: null };

    await act(async () => {
      render(<Harness token={TOKEN} pid={PID} handle={handle} />);
    });

    const ws = wsInstances[wsInstances.length - 1]!;

    await act(async () => {
      ws.triggerOpen();
      ws.triggerMessage({ type: 'producer.added', participantId: REMOTE_PID, kind: 'video' });
      await flush();
    });

    const pc = whepPcs()[whepPcs().length - 1]!;

    // First video track arrives.
    let firstVideo: FakeTrack;
    await act(async () => {
      firstVideo = pc.emitTrack('video', 'track-v1', 'stream-1');
      await flush();
    });

    expect(handle.result!.participants).toHaveLength(2); // local + remote
    const remoteBefore = handle.result!.participants.find((p) => !p.isLocal)!;
    expect(remoteBefore.streams[0]!.getTracks()).toHaveLength(1);

    // Second video track (same kind, different id) arrives — should
    // evict the first and stop it.
    let secondVideo: FakeTrack;
    await act(async () => {
      secondVideo = pc.emitTrack('video', 'track-v2', 'stream-1');
      await flush();
    });

    const remoteAfter = handle.result!.participants.find((p) => !p.isLocal)!;
    const tracks = remoteAfter.streams[0]!.getTracks();
    expect(tracks).toHaveLength(1);
    expect((tracks[0] as unknown as FakeTrack).id).toBe('track-v2');
    expect(firstVideo!.stop).toHaveBeenCalled();
    expect(firstVideo!.readyState).toBe('ended');
    void secondVideo!; // ensure no unused warning
  });

  it('does NOT teardown the whole PC when only one track ends (Finding 6)', async () => {
    const handle: HarnessHandle = { result: null };
    await act(async () => {
      render(<Harness token={TOKEN} pid={PID} handle={handle} />);
    });

    const ws = wsInstances[wsInstances.length - 1]!;
    await act(async () => {
      ws.triggerOpen();
      ws.triggerMessage({ type: 'producer.added', participantId: REMOTE_PID, kind: 'video' });
      await flush();
    });

    const pc = whepPcs()[whepPcs().length - 1]!;
    let audio: FakeTrack;
    let video: FakeTrack;
    await act(async () => {
      audio = pc.emitTrack('audio', 'a1', 's1');
      video = pc.emitTrack('video', 'v1', 's1');
      await flush();
    });

    // End only the audio track.
    await act(async () => {
      audio!.readyState = 'ended';
      for (const cb of audio!._endedListeners) cb();
      await flush();
    });

    // PC must still be alive — video receiver is live.
    expect(pc.closed).toBe(false);
    void video!;
  });

  it('reconnects discovery WS after unexpected close', async () => {
    const handle: HarnessHandle = { result: null };
    jest.useFakeTimers();
    try {
      await act(async () => {
        render(<Harness token={TOKEN} pid={PID} handle={handle} />);
      });
      const wsBefore = wsInstances.length;
      const ws = wsInstances[wsInstances.length - 1]!;
      // Simulate transient drop.
      await act(async () => {
        ws.triggerCloseUnexpected();
      });
      // Advance the reconnect timer.
      await act(async () => {
        jest.advanceTimersByTime(500);
        await Promise.resolve();
      });
      expect(wsInstances.length).toBeGreaterThan(wsBefore);
    } finally {
      jest.useRealTimers();
    }
  });
});
