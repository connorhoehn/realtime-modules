/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/sharedSocketTransport.test.tsx
//
// One host-owned socket shared by several consumers (0.144.0): fan-out of
// inbound frames, refcounted channel subscriptions, re-subscription per
// session epoch, the adapters for usePipelineRunStatus and ui-components'
// EventStreamProvider, and GatewaySocketProvider's useWebSocket passthrough.

import React, { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, renderHook } from '@testing-library/react';
import {
  createSharedSocketTransport,
  defaultChannelService,
  useSharedSocketTransport,
  useSharedWebSocket,
  usePipelineRunStatus,
  usePipelineCatalog,
} from '../../src/client/pipelines';
import type { SharedChannelTransport, SharedSocketTransport, PipelineRunTransport } from '../../src/client/pipelines';
import * as clientEntry from '../../src/client';
import * as wsEntry from '../../src/client/ws';
import { GatewaySocketProvider, useGateway } from '../../src/client/GatewaySocketProvider';

type Frame = Record<string, unknown>;
const sub = (channel: string, service = 'pipeline') => ({ service, action: 'subscribe', channel });
const unsub = (channel: string, service = 'pipeline') => ({ service, action: 'unsubscribe', channel });
const tick = () => act(async () => { await Promise.resolve(); });

function setup(opts: { sessionEpoch?: number; sync?: boolean } = {}) {
  const sent: Frame[] = [];
  const send = jest.fn((f: Frame) => { sent.push(f); });
  const transport = createSharedSocketTransport({
    send,
    ...('sessionEpoch' in opts ? { sessionEpoch: opts.sessionEpoch } : {}),
    ...(opts.sync ? { scheduleRelease: (flush: () => void) => flush() } : {}),
  });
  return { transport, sent, send };
}

describe('exports', () => {
  it('is reachable from ./client, ./client/ws and ./client/pipelines', () => {
    for (const entry of [clientEntry, wsEntry] as Record<string, unknown>[]) {
      expect(entry.createSharedSocketTransport).toBe(createSharedSocketTransport);
      expect(entry.useSharedSocketTransport).toBe(useSharedSocketTransport);
      expect(entry.useSharedWebSocket).toBe(useSharedWebSocket);
    }
  });
});

describe('fan-out', () => {
  it('delivers each frame to every handler; unregister stops one', () => {
    const { transport } = setup();
    const seen = [jest.fn(), jest.fn(), jest.fn()];
    const offs = seen.map((fn) => transport.onMessage(fn));
    transport.deliver({ type: 'a' });
    for (const fn of seen) expect(fn).toHaveBeenCalledWith({ type: 'a' });
    offs[1]!();
    transport.deliver({ type: 'b' });
    expect(seen[0]).toHaveBeenCalledTimes(2);
    expect(seen[1]).toHaveBeenCalledTimes(1);
    expect(seen[2]).toHaveBeenCalledTimes(2);
  });

  it('a throwing handler does not stop the others', () => {
    const onHandlerError = jest.fn();
    const transport = createSharedSocketTransport({ send: jest.fn(), onHandlerError });
    const after = jest.fn();
    transport.onMessage(() => { throw new Error('boom'); });
    transport.onMessage(after);
    transport.deliver({ type: 'x' });
    expect(after).toHaveBeenCalledTimes(1);
    expect(onHandlerError).toHaveBeenCalledWith(expect.any(Error), { type: 'x' });
  });
});

describe('refcounted channels', () => {
  it('two holders send one subscribe; one release sends nothing; the last sends one unsubscribe', async () => {
    const { transport, sent } = setup();
    const a = transport.subscribe('pipeline:run:r1');
    const b = transport.subscribe('pipeline:run:r1');
    expect(sent).toEqual([sub('pipeline:run:r1')]);
    a();
    a(); // idempotent
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1')]);
    expect(transport.holds().get('pipeline:run:r1')).toBe(1);
    b();
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1'), unsub('pipeline:run:r1')]);
    expect(transport.holds().size).toBe(0);
  });

  it('a release followed by a hold in the same tick sends nothing', async () => {
    const { transport, sent } = setup();
    const a = transport.subscribe('pipeline:run:r1');
    a();
    const b = transport.subscribe('pipeline:run:r1');
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1')]);
    b();
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1'), unsub('pipeline:run:r1')]);
  });

  it('scheduleRelease (flush) => flush() sends the unsubscribe immediately', () => {
    const { transport, sent } = setup({ sync: true });
    transport.subscribe('room:1')();
    expect(sent).toEqual([sub('room:1', 'subscribe'), unsub('room:1', 'subscribe')]);
  });

  it('picks the service from the channel unless told', () => {
    expect(defaultChannelService('pipeline:all')).toBe('pipeline');
    expect(defaultChannelService('doc-work:d1')).toBe('subscribe');
    const { transport, sent } = setup();
    transport.subscribe('pipeline:approvals', { service: 'subscribe' });
    expect(sent).toEqual([sub('pipeline:approvals', 'subscribe')]);
  });
});

describe('session epochs', () => {
  it('epoch 0 holds without sending; each new epoch re-sends every held channel once', async () => {
    const { transport, sent } = setup({ sessionEpoch: 0 });
    transport.subscribe('pipeline:run:r1');
    transport.subscribe('pipeline:run:r1');
    transport.subscribe('doc-work:d1');
    expect(sent).toEqual([]);
    transport.update({ sessionEpoch: 1 });
    expect(sent).toEqual([sub('pipeline:run:r1'), sub('doc-work:d1', 'subscribe')]);
    sent.length = 0;
    transport.update({ sessionEpoch: 1 }); // same epoch: nothing
    expect(sent).toEqual([]);
    transport.update({ sessionEpoch: 2 });
    expect(sent).toEqual([sub('pipeline:run:r1'), sub('doc-work:d1', 'subscribe')]);
    expect(transport.sessionEpoch).toBe(2);
  });

  it('a channel released before a new epoch is neither unsubscribed nor re-sent on it', async () => {
    const { transport, sent } = setup({ sessionEpoch: 1 });
    const release = transport.subscribe('pipeline:run:r1');
    release();
    transport.update({ sessionEpoch: 2 });
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1')]);
  });

  it('re-holds after a new epoch do not double the subscribe (consumers re-running their effects)', async () => {
    const { transport, sent } = setup({ sessionEpoch: 1 });
    const a = transport.subscribe('pipeline:run:r1');
    transport.update({ sessionEpoch: 2 });
    a();
    transport.subscribe('pipeline:run:r1');
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1'), sub('pipeline:run:r1')]);
  });

  it('without send, holds wait for one; isOpen gates subscription frames until resubscribe()', () => {
    const sent: Frame[] = [];
    let open = false;
    const transport = createSharedSocketTransport({ isOpen: () => open });
    transport.subscribe('pipeline:all');
    transport.update({ send: (f) => { sent.push(f); } });
    expect(sent).toEqual([]);
    open = true;
    transport.resubscribe();
    expect(sent).toEqual([sub('pipeline:all')]);
  });
});

describe('adapters', () => {
  it('asChannelTransport: EventStreamProvider-shaped holds, an unheld unsubscribe is dropped', async () => {
    const { transport, sent } = setup();
    const ct: SharedChannelTransport = transport.asChannelTransport();
    expect(transport.asChannelTransport()).toBe(ct);
    ct.unsubscribe('pipeline:run:r1'); // nobody held it here
    const other = transport.subscribe('pipeline:run:r1');
    ct.subscribe('pipeline:run:r1');
    ct.unsubscribe('pipeline:run:r1');
    ct.unsubscribe('pipeline:run:r1');
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1')]);
    other();
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1'), unsub('pipeline:run:r1')]);
  });

  it('asPipelineRunTransport: subscription frames become holds, other frames pass through', async () => {
    const { transport, sent } = setup();
    const pt: PipelineRunTransport = transport.asPipelineRunTransport();
    pt.send(sub('pipeline:run:r1'));
    pt.send(sub('pipeline:run:r1'));
    pt.send({ service: 'pipeline', action: 'approve', runId: 'r1' });
    pt.send(unsub('pipeline:run:r1'));
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1'), { service: 'pipeline', action: 'approve', runId: 'r1' }]);
    const fn = jest.fn();
    const off = pt.onMessage(fn);
    transport.deliver({ type: 'x' });
    off();
    transport.deliver({ type: 'y' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // The Studio case: the run page's hook and its execution log (an
  // EventStreamProvider subscriber) watch one run over one socket.
  function FakeEventStreamConsumer({ channelTransport, runId }: { channelTransport: SharedChannelTransport; runId: string }) {
    useEffect(() => {
      channelTransport.subscribe(`pipeline:run:${runId}`);
      return () => channelTransport.unsubscribe(`pipeline:run:${runId}`);
    }, [channelTransport, runId]);
    return null;
  }
  const RUN = { runId: 'r1', pipelineId: 'p' };
  function RunHook({ transport, epoch }: { transport: SharedSocketTransport; epoch?: number }) {
    const status = usePipelineRunStatus([RUN], {
      apiBaseUrl: '', idToken: null, transport: transport.asPipelineRunTransport(), sessionEpoch: epoch,
    });
    return <span data-testid="phase">{status('r1')?.phase ?? 'none'}</span>;
  }

  it('drives usePipelineRunStatus and an EventStreamProvider consumer on one run without unsubscribing each other', async () => {
    const { transport, sent } = setup({ sessionEpoch: 1 });
    const view = render(
      <>
        <RunHook transport={transport} epoch={1} />
        <RunHook transport={transport} epoch={1} />
        <FakeEventStreamConsumer channelTransport={transport.asChannelTransport()} runId="r1" />
      </>,
    );
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1')]);
    act(() => transport.deliver({ type: 'pipeline:event', eventType: 'pipeline.run.started', payload: { runId: 'r1' } }));
    expect(view.getAllByTestId('phase').map((n) => n.textContent)).toEqual(['running', 'running']);

    // The hooks unmount; the event-stream consumer still holds the run.
    view.rerender(<FakeEventStreamConsumer channelTransport={transport.asChannelTransport()} runId="r1" />);
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1')]);
    view.unmount();
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1'), unsub('pipeline:run:r1')]);
  });

  it('a new epoch through useSharedSocketTransport re-sends each run once, with the hooks re-running', async () => {
    const sent: Frame[] = [];
    const send = (f: Frame) => { sent.push(f); };
    function App({ epoch }: { epoch: number }) {
      const transport = useSharedSocketTransport({ send, sessionEpoch: epoch });
      return (
        <>
          <RunHook transport={transport} epoch={epoch} />
          <RunHook transport={transport} epoch={epoch} />
          <FakeEventStreamConsumer channelTransport={transport.asChannelTransport()} runId="r1" />
        </>
      );
    }
    const view = render(<App epoch={0} />);
    await tick();
    expect(sent).toEqual([]);
    view.rerender(<App epoch={1} />);
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1')]);
    view.rerender(<App epoch={2} />);
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1'), sub('pipeline:run:r1')]);
    view.unmount();
    await tick();
    expect(sent).toEqual([sub('pipeline:run:r1'), sub('pipeline:run:r1'), unsub('pipeline:run:r1')]);
  });

  it('the run hook firehose and usePipelineCatalog share one pipeline:all hold, released on unmount', async () => {
    const { transport, sent } = setup({ sessionEpoch: 1 });
    const pt = transport.asPipelineRunTransport();
    const hook = renderHook(() => {
      usePipelineRunStatus([RUN], { apiBaseUrl: '', idToken: null, transport: pt, sessionEpoch: 1, subscribeFirehose: true });
      usePipelineCatalog({ apiBaseUrl: '', idToken: null, transport: pt, sessionEpoch: 1 });
    });
    await tick();
    expect(sent.filter((f) => f.channel === 'pipeline:all')).toEqual([sub('pipeline:all')]);
    hook.unmount();
    await tick();
    expect(sent.filter((f) => f.channel === 'pipeline:all')).toEqual([sub('pipeline:all'), unsub('pipeline:all')]);
  });
});

// ---------------------------------------------------------------------------
// Real socket path: useSharedWebSocket and GatewaySocketProvider passthrough
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

describe('over a real useWebSocket', () => {
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
  const isRunSub = (f: Frame) => f.action === 'subscribe' && f.channel === 'pipeline:run:r1';

  it('useSharedWebSocket fans frames out, calls the host handler, and re-subscribes on the new socket', () => {
    const host = jest.fn();
    const seen = jest.fn();
    const { result } = renderHook(() => {
      const shared = useSharedWebSocket({ url: 'ws://gw.test/ws', onMessage: host });
      useEffect(() => shared.transport.subscribe('pipeline:run:r1'), [shared.transport]);
      useEffect(() => shared.transport.onMessage(seen), [shared.transport]);
      return shared;
    });
    const first = FakeWebSocket.instances[0]!;
    act(() => first.openAndEstablish());
    expect(first.frames(isRunSub)).toHaveLength(1);
    act(() => first.receive({ type: 'pipeline:event', payload: { runId: 'r1' } }));
    expect(host).toHaveBeenCalledWith(expect.objectContaining({ type: 'pipeline:event' }));
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ type: 'pipeline:event' }));

    act(() => first.serverClose());
    act(() => { jest.advanceTimersByTime(5000); });
    const second = FakeWebSocket.instances[1]!;
    act(() => second.openAndEstablish());
    expect(second.frames(isRunSub)).toHaveLength(1);
    expect(result.current.socket.sessionEpoch).toBe(2);
  });

  it('GatewaySocketProvider forwards autoResubscribe', () => {
    const { result } = renderHook(() => useGateway(), {
      wrapper: ({ children }) => (
        <GatewaySocketProvider url="ws://gw.test/ws" rest={null} autoResubscribe>{children}</GatewaySocketProvider>
      ),
    });
    const first = FakeWebSocket.instances[0]!;
    act(() => first.openAndEstablish());
    act(() => result.current.subscribe('room:9'));
    act(() => first.serverClose());
    act(() => { jest.advanceTimersByTime(5000); });
    const second = FakeWebSocket.instances[1]!;
    act(() => second.openAndEstablish());
    expect(second.frames((f) => f.action === 'subscribe' && f.channel === 'room:9')).toHaveLength(1);
  });

  it('GatewaySocketProvider without autoResubscribe does not re-send (default unchanged)', () => {
    const { result } = renderHook(() => useGateway(), {
      wrapper: ({ children }) => <GatewaySocketProvider url="ws://gw.test/ws" rest={null}>{children}</GatewaySocketProvider>,
    });
    const first = FakeWebSocket.instances[0]!;
    act(() => first.openAndEstablish());
    act(() => result.current.subscribe('room:9'));
    act(() => first.serverClose());
    act(() => { jest.advanceTimersByTime(5000); });
    const second = FakeWebSocket.instances[1]!;
    act(() => second.openAndEstablish());
    expect(second.frames((f) => f.action === 'subscribe' && f.channel === 'room:9')).toHaveLength(0);
  });

  it('GatewaySocketProvider forwards maxRetries', () => {
    const { result } = renderHook(() => useGateway(), {
      wrapper: ({ children }) => (
        <GatewaySocketProvider url="ws://gw.test/ws" rest={null} maxRetries={1}>{children}</GatewaySocketProvider>
      ),
    });
    act(() => FakeWebSocket.instances[0]!.serverClose());
    act(() => { jest.advanceTimersByTime(60000); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => FakeWebSocket.instances[1]!.serverClose());
    act(() => { jest.advanceTimersByTime(60000); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result.current.lastError?.code).toBe('RECONNECT_EXHAUSTED');
  });
});
