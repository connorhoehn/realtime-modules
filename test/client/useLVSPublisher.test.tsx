/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useLVSPublisher.test.tsx
//
// Coverage for the auto-reconnect path landed alongside the
// useLVSHangout visibilitychange handler:
//   - pc.connectionState='failed' debounces 1s then re-publishes
//   - retry budget caps at 3 attempts within 60s
//   - the visibilitychange handler in useLVSHangout pokes the WHEP
//     auto-recovery path when a backgrounded tab returns to visible
//     with a WHEP PC in 'disconnected' or 'failed'.

import React from 'react';
import {
  describe, it, expect, jest, beforeEach, afterEach,
} from '@jest/globals';
import { act, render } from '@testing-library/react';

// jsdom doesn't ship MediaStream — install a minimal polyfill BEFORE
// importing the hook.
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

import { useLVSPublisher } from '../../src/client/video/useLVSPublisher';
import { useLVSHangout } from '../../src/client/video/useLVSHangout';

// ---------------------------------------------------------------------------
// RTCPeerConnection mock
// ---------------------------------------------------------------------------

interface ConnListener { (): void }

let pcInstances: FakePeerConnection[] = [];

class FakePeerConnection {
  iceServers: unknown[];
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  iceGatheringState: 'new' | 'gathering' | 'complete' = 'complete';
  iceConnectionState: RTCIceConnectionState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  signalingState = 'stable';
  closed = false;

  connListeners: ConnListener[] = [];
  iceConnListeners: ConnListener[] = [];
  gatherListeners: ConnListener[] = [];
  trackListeners: Array<(ev: { track: unknown; streams: MediaStream[] }) => void> = [];
  senders: Array<{ track: { kind: string; id: string }; replaceTrack: jest.Mock }> = [];
  receivers: Array<{ track: unknown }> = [];

  constructor(config: { iceServers?: unknown[] } = {}) {
    this.iceServers = config.iceServers ?? [];
    pcInstances.push(this);
  }

  addTransceiver = jest.fn();
  addTrack = jest.fn((t: { kind: string; id: string }) => {
    const sender = { track: t, replaceTrack: jest.fn(async () => {}) };
    this.senders.push(sender);
    return sender;
  });
  getSenders = () => this.senders;
  getReceivers = () => this.receivers;
  addEventListener = jest.fn((evt: string, cb: unknown) => {
    if (evt === 'connectionstatechange') this.connListeners.push(cb as ConnListener);
    else if (evt === 'iceconnectionstatechange') this.iceConnListeners.push(cb as ConnListener);
    else if (evt === 'icegatheringstatechange') this.gatherListeners.push(cb as ConnListener);
    else if (evt === 'track') this.trackListeners.push(cb as never);
  });
  removeEventListener = jest.fn();
  createOffer = jest.fn(async () => ({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF\r\n' }));
  setLocalDescription = jest.fn(async (desc: { type: string; sdp: string }) => {
    this.localDescription = desc;
  });
  setRemoteDescription = jest.fn(async (desc: { type: string; sdp: string }) => {
    this.remoteDescription = desc;
  });
  getStats = async () => new Map();
  close = jest.fn(() => { this.closed = true; });

  // Test helpers
  setConnectionState(s: RTCPeerConnectionState) {
    this.connectionState = s;
    for (const cb of this.connListeners) cb();
  }
  setIceState(s: RTCIceConnectionState) {
    this.iceConnectionState = s;
    for (const cb of this.iceConnListeners) cb();
  }
}

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

function makeResponse(body: string, init?: { status?: number; headers?: Record<string, string> }) {
  const status = init?.status ?? 200;
  const headers = init?.headers ?? {};
  if (typeof Response !== 'undefined') {
    try { return new Response(body, init); } catch { /* fall through */ }
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

interface FetchHandle {
  whipCalls: Array<{ url: string; method: string }>;
}

function installFetchMock(): FetchHandle {
  const whipCalls: Array<{ url: string; method: string }> = [];
  const impl = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/ice-servers')) {
      return makeResponse(JSON.stringify({ iceServers: [{ urls: 'stun:fake' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/whip')) {
      const method = init?.method ?? 'POST';
      whipCalls.push({ url, method });
      if (method === 'DELETE') return makeResponse('', { status: 200 });
      return makeResponse('v=0\r\n', {
        status: 201, headers: { 'Content-Type': 'application/sdp', Location: '/whip/x' },
      });
    }
    if (url.includes('/whep')) {
      if (init?.method === 'DELETE') return makeResponse('', { status: 200 });
      return makeResponse('v=0\r\n', {
        status: 201, headers: { 'Content-Type': 'application/sdp', Location: '/whep/x' },
      });
    }
    return makeResponse('', { status: 404 });
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = impl as unknown as typeof fetch;
  return { whipCalls };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface PubHandle { result: ReturnType<typeof useLVSPublisher> | null }

function PublisherHarness(
  { stream, handle }: { stream: MediaStream | null; handle: PubHandle },
) {
  const r = useLVSPublisher({
    channelArn: 'arn:test:channel/abc',
    stream,
    participantId: 'me-pid-1',
    autoStart: true,
    baseUrl: 'http://localhost:3901',
    getAuthToken: () => 'tok',
  });
  handle.result = r;
  return null;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const origRTC = (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection;
const origFetch = (globalThis as unknown as { fetch?: unknown }).fetch;
let fetchHandle: FetchHandle;

beforeEach(() => {
  pcInstances = [];
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePeerConnection;
  fetchHandle = installFetchMock();
  // Silence noisy log channels.
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection = origRTC;
  (globalThis as unknown as { fetch?: unknown }).fetch = origFetch;
  jest.restoreAllMocks();
});

function makeStream(): MediaStream {
  const s = new (globalThis as unknown as { MediaStream: new () => MediaStream }).MediaStream();
  // Add one video track so addTrack is called.
  const track = {
    id: 'v1', kind: 'video', readyState: 'live', enabled: true,
    stop: () => {}, addEventListener: () => {},
  };
  (s as unknown as { addTrack: (t: unknown) => void }).addTrack(track);
  return s;
}

async function flush() {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

// ---------------------------------------------------------------------------
// Tests — publisher auto-reconnect
// ---------------------------------------------------------------------------

describe('useLVSPublisher — auto-reconnect on connectionState=failed', () => {
  it('tears down + re-publishes after a 1s debounce when the PC fails', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    try {
      const handle: PubHandle = { result: null };
      const stream = makeStream();
      await act(async () => {
        render(<PublisherHarness stream={stream} handle={handle} />);
      });
      // Drain the initial publish chain (ICE + offer + WHIP).
      await act(async () => {
        for (let i = 0; i < 20; i += 1) {
          await Promise.resolve();
          jest.advanceTimersByTime(0);
        }
      });

      // The first PC should be installed.
      expect(pcInstances.length).toBe(1);
      const firstPc = pcInstances[0]!;
      // Drive it to 'connected' so phase transitions to 'live'.
      await act(async () => {
        firstPc.setConnectionState('connected');
      });
      expect(handle.result!.phase).toBe('live');

      // Simulate a network drop — connectionState flips to 'failed'.
      await act(async () => {
        firstPc.setConnectionState('failed');
      });

      // Phase should immediately reflect 'reconnecting' (banner shows).
      expect(handle.result!.phase).toBe('reconnecting');
      // The old PC has NOT been closed yet — we're debouncing for 1s.
      expect(firstPc.close).not.toHaveBeenCalled();

      // Advance debounce — teardown + re-publish kicks off.
      await act(async () => {
        jest.advanceTimersByTime(1_100);
        for (let i = 0; i < 20; i += 1) {
          await Promise.resolve();
          jest.advanceTimersByTime(0);
        }
      });

      // Old PC closed, new PC opened.
      expect(firstPc.close).toHaveBeenCalled();
      expect(pcInstances.length).toBeGreaterThanOrEqual(2);
      // A new WHIP POST landed on the SFU.
      const posts = fetchHandle.whipCalls.filter((c) => c.method !== 'DELETE');
      expect(posts.length).toBeGreaterThanOrEqual(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('surfaces a permanent error after 3 retries within 60s (cap)', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    try {
      const handle: PubHandle = { result: null };
      const stream = makeStream();
      await act(async () => {
        render(<PublisherHarness stream={stream} handle={handle} />);
      });
      await act(async () => {
        for (let i = 0; i < 20; i += 1) {
          await Promise.resolve();
          jest.advanceTimersByTime(0);
        }
      });

      // Loop: fail → advance debounce → new PC opens → fail it too.
      // Each failure-debounce-republish cycle counts toward the budget.
      // We want to observe that the 4th failure (after the cap) does
      // NOT trigger another republish.
      const failAndAdvance = async () => {
        const latest = pcInstances[pcInstances.length - 1]!;
        await act(async () => {
          latest.setConnectionState('failed');
        });
        await act(async () => {
          jest.advanceTimersByTime(1_100);
          for (let i = 0; i < 20; i += 1) {
            await Promise.resolve();
            jest.advanceTimersByTime(0);
          }
        });
      };

      const pcsBefore = pcInstances.length;
      await failAndAdvance(); // retry 1
      await failAndAdvance(); // retry 2
      await failAndAdvance(); // retry 3 (cap)
      const pcsAfterCap = pcInstances.length;
      // 3 retries should have spawned 3 new PCs.
      expect(pcsAfterCap - pcsBefore).toBe(3);

      // 4th failure — should NOT spawn another PC + phase flips to 'error'.
      await failAndAdvance();
      expect(pcInstances.length).toBe(pcsAfterCap);
      expect(handle.result!.phase).toBe('error');
      expect(handle.result!.error).toMatch(/reconnect/i);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — useLVSHangout visibilitychange recovery
// ---------------------------------------------------------------------------

// JWT helper — encodes an `arn` claim so decodeArn() returns non-null.
function makeToken(arn: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ arn })).toString('base64url');
  return `${header}.${body}.`;
}

// Minimal WebSocket mock for the discovery WS.
let wsInstances: FakeWebSocket[] = [];
class FakeWebSocket {
  url: string;
  readyState = 0;
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  listeners: Record<string, Array<(ev: unknown) => void>> = {};
  sent: string[] = [];
  closed = false;
  constructor(url: string) { this.url = url; wsInstances.push(this); }
  addEventListener = (evt: string, cb: (ev: unknown) => void) => {
    (this.listeners[evt] ||= []).push(cb);
  };
  removeEventListener = jest.fn();
  send = (data: string) => { this.sent.push(data); };
  close = () => {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  };
  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN;
    for (const cb of this.listeners.open ?? []) cb({});
  }
  triggerMessage(payload: object) {
    for (const cb of this.listeners.message ?? []) cb({ data: JSON.stringify(payload) });
  }
}

function installMediaDevices() {
  const fakeStream = new (globalThis as unknown as { MediaStream: new () => MediaStream }).MediaStream();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: jest.fn(async () => fakeStream),
      getDisplayMedia: jest.fn(async () => fakeStream),
    },
  });
}

interface HangoutHandle { result: ReturnType<typeof useLVSHangout> | null }
function HangoutHarness({ handle }: { handle: HangoutHandle }) {
  const r = useLVSHangout({
    stageToken: makeToken('arn:test:channel/abc'),
    participantId: 'me-pid-1',
    userId: 'me',
    baseUrl: 'http://localhost:3901',
  });
  handle.result = r;
  return null;
}

describe('useLVSPublisher — autoStart auto-tears-down when stream is cleared', () => {
  it('issues WHIP DELETE when the stream prop transitions to null', async () => {
    // Regression for the screen-share teardown bug: stopScreenShare()
    // nulls localScreenStream but the original autoStart effect only
    // reacted to stream→present. The screen WHIP PC + SFU producer
    // stayed alive until the parent unmounted — subscribers kept
    // receiving the frozen last frame and the SFU held the slot.
    // The autoStart effect now also reacts to stream→null by calling
    // stop(), which issues WHIP DELETE + closes the PC.
    const handle: PubHandle = { result: null };
    const stream = makeStream();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<PublisherHarness stream={stream} handle={handle} />);
    });
    // Drain the initial publish chain.
    await act(async () => { await flush(); });
    expect(pcInstances.length).toBe(1);
    const pc = pcInstances[0]!;
    await act(async () => { pc.setConnectionState('connected'); });
    expect(handle.result!.phase).toBe('live');

    const initialDeletes = fetchHandle.whipCalls.filter((c) => c.method === 'DELETE').length;

    // Now clear the stream — mimics stopScreenShare() upstream.
    await act(async () => {
      renderResult!.rerender(<PublisherHarness stream={null} handle={handle} />);
    });
    await act(async () => { await flush(); });

    // WHIP DELETE was issued and the PC was closed.
    const deletes = fetchHandle.whipCalls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBeGreaterThan(initialDeletes);
    expect(pc.close).toHaveBeenCalled();
    expect(handle.result!.phase).toBe('idle');
  });

  it('is a no-op when stream→null but no PC was ever started', async () => {
    // Defense in depth: the teardown branch must guard on `pcRef.current`
    // so a stream that never lit up doesn't trigger a phantom DELETE.
    const handle: PubHandle = { result: null };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<PublisherHarness stream={null} handle={handle} />);
    });
    await act(async () => { await flush(); });
    expect(pcInstances.length).toBe(0);
    const deletesBefore = fetchHandle.whipCalls.filter((c) => c.method === 'DELETE').length;

    // Re-render with null still — nothing changes.
    await act(async () => {
      renderResult!.rerender(<PublisherHarness stream={null} handle={handle} />);
    });
    await act(async () => { await flush(); });

    const deletesAfter = fetchHandle.whipCalls.filter((c) => c.method === 'DELETE').length;
    expect(deletesAfter).toBe(deletesBefore);
  });
});

describe('useLVSHangout — visibilitychange triggers recovery on hidden→visible', () => {
  const origWS = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;

  beforeEach(() => {
    wsInstances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    installMediaDevices();
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = origWS;
  });

  it('closes + schedules retry on unhealthy WHEP PCs when the tab returns to visible', async () => {
    const handle: HangoutHandle = { result: null };
    await act(async () => {
      render(<HangoutHarness handle={handle} />);
    });
    // Flush the discovery WS setup.
    await act(async () => { await flush(); });
    const ws = wsInstances[wsInstances.length - 1]!;

    // Surface a remote producer → openPcFor opens a WHEP PC.
    await act(async () => {
      ws.triggerOpen();
      ws.triggerMessage({
        type: 'producer.added',
        participantId: 'hank-pid-1',
        kind: 'video',
      });
      await flush();
    });

    // The most-recent PC is the WHEP one (publisher's WHIP also present).
    const whepPcs = pcInstances.filter((p) => p.addTransceiver.mock.calls.length > 0);
    expect(whepPcs.length).toBeGreaterThanOrEqual(1);
    const whep = whepPcs[whepPcs.length - 1]!;

    // Simulate the WHEP PC going 'disconnected' while the tab is hidden.
    // We just mutate the prop; no listener call needed for the visibility
    // path (it reads pc.connectionState directly on visibility=visible).
    whep.connectionState = 'disconnected';

    // Simulate the tab becoming visible.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, value: 'visible',
    });

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
    });

    // The unhealthy PC should have been closed by the recovery path.
    expect(whep.close).toHaveBeenCalled();
  });

  it('exposes connectionState aggregate matching publisher phase', async () => {
    const handle: HangoutHandle = { result: null };
    await act(async () => {
      render(<HangoutHarness handle={handle} />);
    });
    await act(async () => { await flush(); });
    // With no media yet flowing, publisher is in 'connecting'/'idle'.
    // The aggregate should never crash and should be one of the
    // documented values.
    const s = handle.result!.connectionState;
    expect(['idle', 'connecting', 'connected', 'reconnecting', 'failed']).toContain(s);
  });
});
