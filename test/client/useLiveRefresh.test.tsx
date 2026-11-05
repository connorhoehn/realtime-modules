/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useLiveRefresh.test.tsx
//
// useLiveRefresh + SharedSocketProvider (0.145.0) and the shared transport's
// per-channel ack state: live = connected AND the channel acknowledged; a
// refused or unanswered channel polls; a reconnect catches up; hidden pauses
// polling; unmount leaves no timers.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, renderHook } from '@testing-library/react';
import {
  createSharedSocketTransport,
  SharedSocketProvider,
  useSharedSocket,
  useLiveRefresh,
  createLiveRefresh,
  useDocumentHidden,
} from '../../src/client/ws';
import type {
  SharedSocketTransport,
  SharedChannelState,
  UseLiveRefreshOptions,
  UseLiveRefreshResult,
  ConnectionState,
} from '../../src/client/ws';
import * as clientEntry from '../../src/client';
import * as wsEntry from '../../src/client/ws';
import * as pipelinesEntry from '../../src/client/pipelines';
import { GatewaySocketProvider } from '../../src/client/GatewaySocketProvider';

type Frame = Record<string, unknown>;
const CH = 'studio:project:p1';
const ack = (channel = CH, type = 'subscribe') => ({ type, action: 'subscribed', channel });
const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

function transportWith(epoch = 1) {
  const sent: Frame[] = [];
  const transport = createSharedSocketTransport({
    send: (f) => { sent.push(f); },
    sessionEpoch: epoch,
    scheduleRelease: (fn) => fn(),
  });
  return { transport, sent };
}

describe('exports', () => {
  it('is reachable from ./client, ./client/ws and ./client/pipelines', () => {
    for (const entry of [clientEntry, wsEntry, pipelinesEntry] as Record<string, unknown>[]) {
      expect(entry.useLiveRefresh).toBe(useLiveRefresh);
      expect(entry.createLiveRefresh).toBe(createLiveRefresh);
      expect(entry.SharedSocketProvider).toBe(SharedSocketProvider);
      expect(entry.useSharedSocket).toBe(useSharedSocket);
      expect(entry.useDocumentHidden).toBe(useDocumentHidden);
    }
  });
});

describe('shared transport channel state', () => {
  it('pending until acked; an error naming it refuses; a new epoch is pending again; release is unheld', () => {
    const { transport } = transportWith();
    const seen: Array<[string, SharedChannelState]> = [];
    transport.onChannelState((c, s) => seen.push([c, s]));
    expect(transport.channelState(CH)).toBe('unheld');
    const release = transport.subscribe(CH);
    expect(transport.channelState(CH)).toBe('pending');
    transport.deliver(ack());
    expect(transport.channelState(CH)).toBe('subscribed');
    transport.update({ sessionEpoch: 2 });
    expect(transport.channelState(CH)).toBe('pending');
    transport.deliver({ type: 'error', code: 'AUTHZ_CHANNEL_DENIED', kind: 'subscribe', channel: CH });
    expect(transport.channelState(CH)).toBe('refused');
    release();
    expect(transport.channelState(CH)).toBe('unheld');
    expect(seen).toEqual([[CH, 'pending'], [CH, 'subscribed'], [CH, 'pending'], [CH, 'refused'], [CH, 'unheld']]);
  });

  it('the pipeline feature acks and refusals count; a refused publish does not', () => {
    const { transport } = transportWith();
    transport.subscribe('pipeline:run:r1');
    transport.deliver(ack('pipeline:run:r1', 'pipeline'));
    expect(transport.channelState('pipeline:run:r1')).toBe('subscribed');
    transport.deliver({ type: 'error', code: 'AUTHZ_CHANNEL_DENIED', kind: 'publish', channel: 'pipeline:run:r1' });
    expect(transport.channelState('pipeline:run:r1')).toBe('subscribed');
    transport.update({ sessionEpoch: 2 });
    transport.deliver({ type: 'error', code: 'PIPELINE_CHANNEL_REFUSED', channel: 'pipeline:run:r1' });
    expect(transport.channelState('pipeline:run:r1')).toBe('refused');
  });

  it('a second holder sees the first holder\'s ack (one subscribe, one answer)', () => {
    const { transport, sent } = transportWith();
    transport.subscribe(CH);
    transport.deliver(ack());
    transport.subscribe(CH);
    expect(sent.filter((f) => f.action === 'subscribe')).toHaveLength(1);
    expect(transport.channelState(CH)).toBe('subscribed');
  });

  it('acks for channels nobody holds are ignored', () => {
    const { transport } = transportWith();
    transport.deliver(ack('other'));
    expect(transport.channelState('other')).toBe('unheld');
  });
});

// ---------------------------------------------------------------------------
// The hook over a bound provider
// ---------------------------------------------------------------------------

interface Reads { calls: number; resolve: (v: string) => void; reject: (e: Error) => void; pending: Array<{ resolve: (v: string) => void; reject: (e: Error) => void; signal: AbortSignal }> }

function reader(): Reads & { read: (signal: AbortSignal) => Promise<string> } {
  const r = {
    calls: 0,
    pending: [] as Reads['pending'],
    read(signal: AbortSignal) {
      r.calls += 1;
      return new Promise<string>((resolve, reject) => { r.pending.push({ resolve, reject, signal }); });
    },
    resolve(v: string) { r.pending.shift()!.resolve(v); },
    reject(e: Error) { r.pending.shift()!.reject(e); },
  };
  return r;
}

function mount(opts: {
  transport: SharedSocketTransport;
  connectionState?: ConnectionState;
  sessionEpoch?: number;
  read: (signal: AbortSignal) => Promise<string>;
  options?: UseLiveRefreshOptions<string>;
}) {
  const out: { current: UseLiveRefreshResult<string> | null } = { current: null };
  function Probe({ options }: { options?: UseLiveRefreshOptions<string> }) {
    out.current = useLiveRefresh(opts.read, options);
    return null;
  }
  const view = (connectionState: ConnectionState, sessionEpoch: number | undefined, options = opts.options) => (
    <SharedSocketProvider socket={{ connectionState, sessionEpoch }} transport={opts.transport}>
      <Probe options={options} />
    </SharedSocketProvider>
  );
  const r = render(view(opts.connectionState ?? 'connected', opts.sessionEpoch ?? 1));
  return {
    out,
    unmount: r.unmount,
    set(connectionState: ConnectionState, sessionEpoch?: number, options?: UseLiveRefreshOptions<string>) {
      r.rerender(view(connectionState, sessionEpoch, options ?? opts.options));
    },
  };
}

describe('useLiveRefresh', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('live only after the channel ack; catch-up read on becoming live; a hint frame re-reads, coalesced', async () => {
    const { transport, sent } = transportWith();
    const r = reader();
    const m = mount({ transport, read: r.read, options: { channel: CH, coalesceMs: 100, pollMs: 10_000 } });
    expect(sent).toEqual([{ service: 'subscribe', action: 'subscribe', channel: CH }]);
    expect(r.calls).toBe(1);                  // the first read
    await act(async () => { r.resolve('v1'); });
    expect(m.out.current!.data).toBe('v1');
    expect(m.out.current!.live).toBe(false);  // connected, not yet acked
    expect(m.out.current!.channelState).toBe('pending');

    act(() => transport.deliver(ack()));
    expect(m.out.current!.live).toBe(true);
    expect(r.calls).toBe(2);                  // catch-up
    await act(async () => { r.resolve('v2'); });

    act(() => {
      transport.deliver({ type: 'studio.work.changed', channel: CH });
      transport.deliver({ type: 'studio.work.changed', channel: CH });
      transport.deliver({ type: 'unrelated', channel: 'elsewhere' });
    });
    expect(r.calls).toBe(2);                  // inside the window
    act(() => { jest.advanceTimersByTime(100); });
    expect(r.calls).toBe(3);                  // one read for both hints
    await act(async () => { r.resolve('v3'); });
    expect(m.out.current!.data).toBe('v3');
    m.unmount();
  });

  it('isHint picks the frames; the default ignores acks and errors on the channel', async () => {
    const { transport } = transportWith();
    const r = reader();
    const m = mount({
      transport, read: r.read,
      options: { channel: CH, isHint: (f) => f.type === 'studio.work.changed' && f.projectId === 'p1' },
    });
    await act(async () => { r.resolve('a'); });
    act(() => transport.deliver(ack()));
    await act(async () => { r.resolve('b'); });
    act(() => transport.deliver({ type: 'studio.work.changed', projectId: 'p2' }));
    expect(r.calls).toBe(2);
    act(() => transport.deliver({ type: 'studio.work.changed', projectId: 'p1' }));
    expect(r.calls).toBe(3);
    m.unmount();
  });

  it('a refused channel falls back to polling', async () => {
    const { transport } = transportWith();
    const r = reader();
    const m = mount({ transport, read: r.read, options: { channel: CH, pollMs: 1000, livePollMs: 0 } });
    await act(async () => { r.resolve('a'); });
    act(() => transport.deliver({ type: 'error', code: 'AUTHZ_CHANNEL_DENIED', kind: 'subscribe', channel: CH }));
    expect(m.out.current!.live).toBe(false);
    expect(m.out.current!.channelState).toBe('refused');
    act(() => { jest.advanceTimersByTime(1000); });
    expect(r.calls).toBe(2);
    await act(async () => { r.resolve('b'); });
    act(() => { jest.advanceTimersByTime(1000); });
    expect(r.calls).toBe(3);
    m.unmount();
  });

  it('isRefusal covers a refusal naming the mapped router channel', async () => {
    const { transport } = transportWith();
    const r = reader();
    const m = mount({
      transport, read: r.read,
      options: { channel: 'pipeline:run:r1', isRefusal: (f) => f.type === 'error' && f.channel === 'tenant:flowrun:r1' },
    });
    await act(async () => { r.resolve('a'); });
    act(() => transport.deliver(ack('pipeline:run:r1', 'pipeline')));
    expect(m.out.current!.live).toBe(true);
    await act(async () => { r.resolve('b'); });
    act(() => transport.deliver({ type: 'error', code: 'AUTHZ_CHANNEL_DENIED', channel: 'tenant:flowrun:r1' }));
    expect(m.out.current!.live).toBe(false);
    m.unmount();
  });

  it('while live, polling is the slow safety read; while not, pollMs', async () => {
    const { transport } = transportWith();
    const r = reader();
    const m = mount({ transport, read: r.read, options: { channel: CH, pollMs: 1000, livePollMs: 30_000 } });
    await act(async () => { r.resolve('a'); });
    act(() => transport.deliver(ack()));
    await act(async () => { r.resolve('b'); });
    act(() => { jest.advanceTimersByTime(29_999); });
    expect(r.calls).toBe(2);
    act(() => { jest.advanceTimersByTime(1); });
    expect(r.calls).toBe(3);
    m.unmount();
  });

  it('a reconnect drops to polling, then catches up once the new session acks', async () => {
    const { transport, sent } = transportWith();
    const r = reader();
    const m = mount({ transport, read: r.read, options: { channel: CH, pollMs: 10_000 } });
    await act(async () => { r.resolve('a'); });
    act(() => transport.deliver(ack()));
    await act(async () => { r.resolve('b'); });
    m.set('reconnecting', 1);
    expect(m.out.current!.live).toBe(false);
    // The host's useSharedWebSocket re-binds the transport on the new session.
    act(() => transport.update({ sessionEpoch: 2 }));
    m.set('connected', 2);
    expect(sent.filter((f) => f.action === 'subscribe')).toHaveLength(2); // re-sent for the new session
    expect(m.out.current!.live).toBe(false);  // pending in session 2
    expect(r.calls).toBe(2);
    act(() => transport.deliver(ack()));
    expect(m.out.current!.live).toBe(true);
    expect(r.calls).toBe(3);                  // catch-up
    m.unmount();
  });

  it('two hooks on one channel hold one subscription; one unmounting keeps it', async () => {
    const { transport, sent } = transportWith();
    const r1 = reader(); const r2 = reader();
    const a = mount({ transport, read: r1.read, options: { channel: CH } });
    const b = mount({ transport, read: r2.read, options: { channel: CH } });
    act(() => transport.deliver(ack()));
    expect(a.out.current!.live && b.out.current!.live).toBe(true);
    a.unmount();
    expect(sent.filter((f) => f.action === 'unsubscribe')).toHaveLength(0);
    expect(transport.holds().get(CH)).toBe(1);
    b.unmount();
    expect(sent.filter((f) => f.action === 'unsubscribe')).toHaveLength(1);
  });

  it('without a channel, live is the connection itself', async () => {
    const { transport } = transportWith();
    const r = reader();
    const m = mount({ transport, read: r.read, connectionState: 'disconnected', options: {} });
    expect(m.out.current!.live).toBe(false);
    await act(async () => { r.resolve('a'); });
    m.set('connected', 1, {});
    expect(m.out.current!.live).toBe(true);
    expect(r.calls).toBe(2);
    m.unmount();
  });

  it('socket: null polls only; no provider polls only', async () => {
    const r = reader();
    const { result, unmount } = renderHook(() => useLiveRefresh(r.read, { channel: CH, pollMs: 500, socket: null }));
    expect(result.current.connectionState).toBeNull();
    expect(result.current.live).toBe(false);
    await act(async () => { r.resolve('a'); });
    act(() => { jest.advanceTimersByTime(500); });
    expect(r.calls).toBe(2);
    unmount();
    const r2 = reader();
    const h2 = renderHook(() => useLiveRefresh(r2.read, { pollMs: 500 }));
    expect(h2.result.current.live).toBe(false);
    h2.unmount();
  });

  it('backs off failed reads and reports the error; a success clears it', async () => {
    const r = reader();
    const { result, unmount } = renderHook(() => useLiveRefresh(r.read, { pollMs: 100, socket: null }));
    await act(async () => { r.reject(new Error('down')); });
    expect((result.current.error as Error).message).toBe('down');
    expect(result.current.loading).toBe(false);
    act(() => { jest.advanceTimersByTime(199); });
    expect(r.calls).toBe(1);
    act(() => { jest.advanceTimersByTime(1); });
    expect(r.calls).toBe(2);
    await act(async () => { r.resolve('ok'); });
    expect(result.current.error).toBeUndefined();
    expect(result.current.data).toBe('ok');
    unmount();
  });

  it('hidden pauses polling; visible resumes', async () => {
    let hidden = false;
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    try {
      const r = reader();
      const { unmount } = renderHook(() => useLiveRefresh(r.read, { pollMs: 100, socket: null }));
      await act(async () => { r.resolve('a'); });
      act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
      act(() => { jest.advanceTimersByTime(10_000); });
      expect(r.calls).toBe(1);
      act(() => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
      expect(r.calls).toBe(2);              // overdue: reads at once
      unmount();
    } finally {
      delete (document as { hidden?: boolean }).hidden;
      if (desc) Object.defineProperty(Document.prototype, 'hidden', desc);
    }
  });

  it('a channel change starts over; unmount aborts the read and leaves no timers', async () => {
    // Every setTimeout the hook arms must be cleared or fired by unmount
    // (React's own scheduler work is not counted: it is not a setTimeout).
    const armed = new Set<unknown>();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const setSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const id: unknown = realSet(() => { armed.delete(id); fn(); }, ms);
      armed.add(id);
      return id;
    }) as typeof setTimeout);
    const clearSpy = jest.spyOn(globalThis, 'clearTimeout').mockImplementation(((id: unknown) => {
      armed.delete(id);
      realClear(id as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout);
    try {
      const { transport } = transportWith();
      const r = reader();
      const m = mount({ transport, read: r.read, options: { channel: CH, coalesceMs: 100 } });
      await act(async () => { r.resolve('a'); });
      expect(m.out.current!.data).toBe('a');
      expect(armed.size).toBe(1);               // the poll
      m.set('connected', 1, { channel: 'studio:project:p2', coalesceMs: 100 });
      expect(m.out.current!.data).toBeUndefined();
      expect(r.calls).toBe(2);
      expect(armed.size).toBe(0);               // the old poll is gone
      act(() => transport.deliver(ack('studio:project:p2')));
      act(() => transport.deliver({ type: 'x', channel: 'studio:project:p2' })); // coalesce timer
      expect(armed.size).toBe(1);
      const inFlight = r.pending[r.pending.length - 1]!;
      m.unmount();
      expect(inFlight.signal.aborted).toBe(true);
      expect(armed.size).toBe(0);
      expect(transport.holds().size).toBe(0);
      act(() => { jest.advanceTimersByTime(120_000); });
      expect(r.calls).toBe(2);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('enabled: false reads nothing and holds nothing', () => {
    const { transport, sent } = transportWith();
    const r = reader();
    const m = mount({ transport, read: r.read, options: { channel: CH, enabled: false } });
    expect(r.calls).toBe(0);
    expect(sent).toHaveLength(0);
    expect(m.out.current!.loading).toBe(false);
    m.unmount();
  });
});

// ---------------------------------------------------------------------------
// The provider: owned socket, bound socket, gateway bridge
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  constructor(url: string) { this.url = url; FakeWebSocket.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  openAndEstablish(): void {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: 'session', status: 'connected', clientId: 'c-1' }) });
  }
  serverClose(): void { this.readyState = 3; this.onclose?.({ code: 1006, reason: 'lost' }); }
  receive(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }); }
  frames(match: (f: Frame) => boolean): Frame[] {
    return this.sent.map((s) => JSON.parse(s) as Frame).filter(match);
  }
}

describe('SharedSocketProvider', () => {
  const realWS = (globalThis as { WebSocket?: unknown }).WebSocket;
  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    (globalThis as { WebSocket?: unknown }).WebSocket = realWS;
  });

  it('useSharedSocket is null outside a provider', () => {
    const { result } = renderHook(() => useSharedSocket());
    expect(result.current).toBeNull();
  });

  it('owned socket: the transport is the same object while disconnected; connectionState and live follow the socket', async () => {
    const r = reader();
    const { result } = renderHook(() => ({ shared: useSharedSocket(), refresh: useLiveRefresh(r.read, { channel: CH, pollMs: 60_000 }) }), {
      wrapper: ({ children }) => <SharedSocketProvider options={{ url: 'ws://gw.test/ws' }}>{children}</SharedSocketProvider>,
    });
    const transport = result.current.shared!.transport;
    expect(transport).toBeTruthy();
    expect(result.current.shared!.live).toBe(false);
    const first = FakeWebSocket.instances[0]!;
    act(() => first.openAndEstablish());
    expect(result.current.shared!.connectionState).toBe('connected');
    expect(result.current.shared!.live).toBe(true);
    expect(first.frames((f) => f.action === 'subscribe' && f.channel === CH)).toHaveLength(1);
    await act(async () => { r.resolve('a'); });
    act(() => first.receive(ack()));
    expect(result.current.refresh.live).toBe(true);
    await act(async () => { r.resolve('b'); });

    act(() => first.serverClose());
    expect(result.current.shared!.live).toBe(false);
    expect(result.current.shared!.transport).toBe(transport);  // never nulled
    expect(result.current.refresh.live).toBe(false);
    act(() => { jest.advanceTimersByTime(5000); });
    const second = FakeWebSocket.instances[1]!;
    act(() => second.openAndEstablish());
    expect(second.frames((f) => f.action === 'subscribe' && f.channel === CH)).toHaveLength(1);
    const before = r.calls;
    act(() => second.receive(ack()));
    expect(result.current.refresh.live).toBe(true);
    expect(r.calls).toBe(before + 1);  // re-read on reconnect
  });

  it('fromGateway bridges the nearest GatewaySocketProvider', () => {
    const r = reader();
    const { result } = renderHook(() => useLiveRefresh(r.read, { channel: CH }), {
      wrapper: ({ children }) => (
        <GatewaySocketProvider url="ws://gw.test/ws" rest={null}>
          <SharedSocketProvider fromGateway>{children}</SharedSocketProvider>
        </GatewaySocketProvider>
      ),
    });
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.openAndEstablish());
    expect(ws.frames((f) => f.action === 'subscribe' && f.channel === CH)).toHaveLength(1);
    act(() => ws.receive(ack()));
    expect(result.current.live).toBe(true);
  });
});

