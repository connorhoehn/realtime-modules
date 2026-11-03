/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useLVSSubscriber.ice.test.tsx
//
// The subscriber resolves its stage token before the ICE fetch so the SFU can
// include TURN entries for it, sends that same token on WHEP, and builds its
// peer connection with the SFU's iceTransportPolicy.

import React from 'react';
import {
  describe, it, expect, jest, beforeEach, afterEach,
} from '@jest/globals';
import { act, renderHook } from '@testing-library/react';

class FakeMediaStream {
  id = `stream-${Math.random().toString(36).slice(2, 9)}`;
  private _tracks: unknown[] = [];
  getTracks() { return this._tracks; }
  addTrack(t: unknown) { this._tracks.push(t); }
}
(globalThis as unknown as { MediaStream: unknown }).MediaStream = FakeMediaStream;

import { LVSProvider } from '../../src/client/video/LVSProvider';
import { useLVSSubscriber } from '../../src/client/video/useLVSSubscriber';

let pcInstances: FakePeerConnection[] = [];

class FakePeerConnection {
  iceServers: unknown[];
  iceTransportPolicy: RTCIceTransportPolicy | undefined;
  localDescription: { type: string; sdp: string } | null = null;
  iceGatheringState = 'complete';
  iceConnectionState = 'new';
  connectionState = 'new';
  closed = false;
  constructor(config: { iceServers?: unknown[]; iceTransportPolicy?: RTCIceTransportPolicy } = {}) {
    this.iceServers = config.iceServers ?? [];
    this.iceTransportPolicy = config.iceTransportPolicy;
    pcInstances.push(this);
  }
  addTransceiver = jest.fn();
  addEventListener = jest.fn();
  removeEventListener = jest.fn();
  createOffer = jest.fn(async () => ({ type: 'offer', sdp: 'v=0\r\n' }));
  setLocalDescription = jest.fn(async (d: { type: string; sdp: string }) => { this.localDescription = d; });
  setRemoteDescription = jest.fn(async () => {});
  getReceivers = () => [];
  getStats = async () => new Map();
  close = jest.fn(() => { this.closed = true; });
}

interface Call { url: string; init?: RequestInit }

// jsdom has no global Response; a minimal stand-in covers what the transport reads.
function res(body: string, status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    url: '',
    headers: { get: (k: string) => headers[k] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

function installFetch(iceBody: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = jest.fn(async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/api/ice-servers')) return res(JSON.stringify(iceBody), 200);
    if (String(url).includes('/whep')) {
      if (init?.method === 'DELETE') return res('', 200);
      return res('v=0\r\n', 201, { Location: '/whep/x' });
    }
    return res('', 404);
  }) as typeof fetch;
  return calls;
}

const auth = (c: Call | undefined) =>
  (c?.init?.headers as Record<string, string> | undefined)?.Authorization ?? null;

async function flush() {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

const origRTC = (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection;
const origFetch = globalThis.fetch;

beforeEach(() => {
  pcInstances = [];
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePeerConnection;
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection = origRTC;
  globalThis.fetch = origFetch;
  jest.restoreAllMocks();
});

function mount(getAuthToken: () => string | Promise<string>) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <LVSProvider baseUrl="http://sfu" getAuthToken={getAuthToken} log={() => {}}>{children}</LVSProvider>
  );
  return renderHook(() => useLVSSubscriber({ channelArn: 'arn:test:channel/abc' }), { wrapper });
}

describe('useLVSSubscriber — authenticated ICE config', () => {
  it('sends the stage token on the ICE fetch and on WHEP, and builds the PC with the relay policy', async () => {
    const turn = [{ urls: 'turn:t.example:3478', username: 'u', credential: 'c' }];
    const calls = installFetch({ iceServers: turn, iceTransportPolicy: 'relay' });
    const getAuthToken = jest.fn(() => 'stage.jwt');
    let hook!: ReturnType<typeof mount>;
    await act(async () => { hook = mount(getAuthToken); await flush(); });

    const ice = calls.filter((c) => c.url.includes('/api/ice-servers'));
    const whep = calls.filter((c) => c.url.includes('/whep') && c.init?.method === 'POST');
    expect(ice).toHaveLength(1);
    expect(auth(ice[0])).toBe('Bearer stage.jwt');
    expect(whep).toHaveLength(1);
    expect(auth(whep[0])).toBe('Bearer stage.jwt');
    // One resolution per start, as before: the ICE fetch and WHEP share it.
    expect(getAuthToken).toHaveBeenCalledTimes(1);
    expect(pcInstances).toHaveLength(1);
    expect(pcInstances[0]!.iceServers).toEqual(turn);
    expect(pcInstances[0]!.iceTransportPolicy).toBe('relay');
    await act(async () => { await hook.result.current.stop(); hook.unmount(); });
  });

  it("honours an empty list and defaults the policy to 'all'", async () => {
    installFetch({ iceServers: [] });
    let hook!: ReturnType<typeof mount>;
    await act(async () => { hook = mount(() => 'stage.jwt'); await flush(); });
    expect(pcInstances).toHaveLength(1);
    expect(pcInstances[0]!.iceServers).toEqual([]);
    expect(pcInstances[0]!.iceTransportPolicy).toBe('all');
    await act(async () => { await hook.result.current.stop(); hook.unmount(); });
  });

  it('a token that cannot be resolved fails before any PC is built', async () => {
    const calls = installFetch({ iceServers: [] });
    let hook!: ReturnType<typeof mount>;
    await act(async () => {
      hook = mount(() => { throw new Error('no token'); });
      await flush();
    });
    expect(calls.filter((c) => c.url.includes('/api/ice-servers'))).toHaveLength(0);
    expect(pcInstances).toHaveLength(0);
    expect(hook.result.current.error).toBe('no token');
    await act(async () => { await hook.result.current.stop(); hook.unmount(); });
  });
});
