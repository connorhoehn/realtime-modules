/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useCapabilities.test.tsx
//
// The plural capability hook — the one an exportable surface uses, because
// React forbids calling the singular hook in a loop and a surface that
// composes on a SET of capabilities has to be handed that set as data.
//
// It shipped without tests. Two of the behaviours below are the ones that
// decide whether a capability gate is safe to put in front of a product:
//
//   - what an unresolved name reports while loading (false, so a caller never
//     flashes a control it is about to hide), and
//   - how often it asks. The effect used to key on the whole gateway context,
//     which is rebuilt on every connection-state change: five names produced
//     thirty HTTP calls on one mount, and re-asked on every reconnect.

import React from 'react';
import { describe, it, expect, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { GatewayContext } from '../../src/client/GatewaySocketProvider';
import type { GatewayContextValue } from '../../src/client/GatewaySocketProvider';
import type { GatewayMessage } from '../../src/client/types';
import { useCapabilities } from '../../src/client/useCapabilities';

type GetCapability = (
  name: string,
  channel?: string,
) => Promise<{ enabled: boolean; version?: string; metadata?: Record<string, unknown> }>;

function makeGatewayContext(getCapability?: GetCapability) {
  const handlers = new Set<(msg: GatewayMessage) => void>();
  const ctx = {
    connectionState: 'connected',
    lastError: null,
    sessionToken: null,
    clientId: 'client-1',
    currentChannel: 'ch-1',
    switchChannel: jest.fn(),
    sendMessage: jest.fn(),
    disconnect: jest.fn(),
    reconnect: jest.fn(),
    send: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    publish: jest.fn(),
    onMessage: (handler: (msg: GatewayMessage) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    ...(getCapability ? { rest: { getCapability } } : {}),
  } as unknown as GatewayContextValue;

  return {
    ctx,
    emit: (msg: GatewayMessage) => { for (const h of handlers) h(msg); },
  };
}

const wrapperFor = (ctx: GatewayContextValue) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <GatewayContext.Provider value={ctx}>{children}</GatewayContext.Provider>;
  };

const answering = (verdicts: Record<string, boolean>) =>
  jest.fn(async (name: string, _channel?: string) => ({ enabled: verdicts[name] ?? false }));

const NAMES = ['conversation.files', 'conversation.documents'];

describe('resolving a set', () => {
  it('answers each name independently', async () => {
    const { ctx } = makeGatewayContext(
      answering({ 'conversation.files': true, 'conversation.documents': false }),
    );
    const { result } = renderHook(() => useCapabilities(NAMES), { wrapper: wrapperFor(ctx) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toEqual({
      'conversation.files': true,
      'conversation.documents': false,
    });
  });

  // So a caller that renders straight off `enabled` never shows a control it
  // is about to take away.
  it('reports every unresolved name as false while loading', () => {
    const { ctx } = makeGatewayContext(() => new Promise(() => {}));
    const { result } = renderHook(() => useCapabilities(NAMES), { wrapper: wrapperFor(ctx) });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.enabled).toEqual({
      'conversation.files': false,
      'conversation.documents': false,
    });
  });

  // A gateway that predates the endpoint must keep working.
  it('treats a 404 as enabled, and only for the name that 404d', async () => {
    const getCapability = jest.fn(async (name: string) => {
      if (name === 'conversation.files') {
        const err = new Error('not found') as Error & { status?: number };
        err.status = 404;
        throw err;
      }
      return { enabled: false };
    });
    const { ctx } = makeGatewayContext(getCapability as unknown as GetCapability);
    const { result } = renderHook(() => useCapabilities(NAMES), { wrapper: wrapperFor(ctx) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled['conversation.files']).toBe(true);
    expect(result.current.enabled['conversation.documents']).toBe(false);
  });

  it('is optimistic when there is no REST surface to ask', async () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(() => useCapabilities(NAMES), { wrapper: wrapperFor(ctx) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toEqual({
      'conversation.files': true,
      'conversation.documents': true,
    });
  });

  // Reported rather than swallowed: `enabled` says false for everything on a
  // failure, which is indistinguishable from "provisions nothing" unless the
  // caller can see the error and decide.
  it('surfaces a real failure so the caller can tell it from a verdict', async () => {
    const { ctx } = makeGatewayContext(async () => { throw new Error('HTTP 500'); });
    const { result } = renderHook(() => useCapabilities(NAMES), { wrapper: wrapperFor(ctx) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('asks about nothing when given no names', async () => {
    const getCapability = answering({});
    const { ctx } = makeGatewayContext(getCapability as unknown as GetCapability);
    const { result } = renderHook(() => useCapabilities([]), { wrapper: wrapperFor(ctx) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getCapability).not.toHaveBeenCalled();
  });
});

describe('how often it asks', () => {
  // Callers write useCapabilities(['a','b']) — a new array every render.
  it('does not re-ask when the caller passes a fresh array of the same names', async () => {
    const getCapability = answering({});
    const { ctx } = makeGatewayContext(getCapability as unknown as GetCapability);
    const { result, rerender } = renderHook(
      () => useCapabilities(['conversation.files', 'conversation.documents']),
      { wrapper: wrapperFor(ctx) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const first = getCapability.mock.calls.length;

    rerender();
    rerender();

    expect(getCapability.mock.calls.length).toBe(first);
  });

  // The context value is rebuilt whenever the connection state changes. Keying
  // the effect on it re-resolved everything on every reconnect.
  it('does not re-ask when the gateway context identity changes', async () => {
    const getCapability = answering({});
    const { ctx } = makeGatewayContext(getCapability as unknown as GetCapability);
    const { result, rerender } = renderHook(() => useCapabilities(NAMES), {
      wrapper: wrapperFor(ctx),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const first = getCapability.mock.calls.length;
    expect(first).toBe(NAMES.length);

    // Same rest handle and same bus, new object — exactly what a reconnect
    // produces.
    const churned = { ...(ctx as object) } as GatewayContextValue;
    rerender({ wrapper: wrapperFor(churned) } as never);

    expect(getCapability.mock.calls.length).toBe(first);
  });

  it('re-asks when the channel changes, because the answer is per channel', async () => {
    const getCapability = answering({});
    const { ctx } = makeGatewayContext(getCapability as unknown as GetCapability);
    const { result, rerender } = renderHook(
      ({ channel }: { channel: string }) => useCapabilities(NAMES, channel),
      { wrapper: wrapperFor(ctx), initialProps: { channel: 'ch-1' } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const first = getCapability.mock.calls.length;

    rerender({ channel: 'ch-2' });
    await waitFor(() => expect(getCapability.mock.calls.length).toBe(first + NAMES.length));
    expect(getCapability.mock.calls.at(-1)?.[1]).toBe('ch-2');
  });
});

describe('live updates', () => {
  it('honours a capability:updated push without a remount', async () => {
    const { ctx, emit } = makeGatewayContext(answering({ 'conversation.files': false }));
    const { result } = renderHook(() => useCapabilities(NAMES), { wrapper: wrapperFor(ctx) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      emit({
        type: 'capability:updated',
        payload: { name: 'conversation.files', enabled: true },
      } as unknown as GatewayMessage);
    });

    expect(result.current.enabled['conversation.files']).toBe(true);
  });

  it('ignores an update for a name it was not asked about', async () => {
    const { ctx, emit } = makeGatewayContext(answering({}));
    const { result } = renderHook(() => useCapabilities(NAMES), { wrapper: wrapperFor(ctx) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      emit({
        type: 'capability:updated',
        payload: { name: 'something.else', enabled: true },
      } as unknown as GatewayMessage);
    });

    expect(result.current.enabled['something.else']).toBeUndefined();
  });

  // A per-channel toggle must not leak across channels.
  it('ignores a channel-scoped update meant for another channel', async () => {
    const { ctx, emit } = makeGatewayContext(answering({ 'conversation.files': false }));
    const { result } = renderHook(() => useCapabilities(NAMES, 'ch-1'), {
      wrapper: wrapperFor(ctx),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      emit({
        type: 'capability:updated',
        payload: { name: 'conversation.files', enabled: true, channel: 'ch-2' },
      } as unknown as GatewayMessage);
    });

    expect(result.current.enabled['conversation.files']).toBe(false);
  });
});
