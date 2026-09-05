/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/usePins.test.tsx
//
// Pinned messages: channel state, not message content.
//
// The properties worth pinning down are the ones that make a pin behave like
// something everyone shares rather than a local bookmark — it comes back from
// the server, it does not follow you to another channel, and a failed write
// leaves the panel the way the server has it.

import React from 'react';
import { describe, it, expect, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { GatewayContext } from '../../src/client/GatewaySocketProvider';
import type { GatewayContextValue, PinnedMessage } from '../../src/client/GatewaySocketProvider';
import type { GatewayMessage } from '../../src/client/types';
import { usePins } from '../../src/client/usePins';

const pinRow = (over: Partial<PinnedMessage> = {}): PinnedMessage => ({
  channelId: 'ch-1',
  messageId: 'm1',
  pinnedBy: 'dev-hank',
  pinnedAt: '2026-09-05T08:00:00.000Z',
  preview: 'the upload path is live',
  author: 'Hank Anderson',
  ...over,
});

function makeGateway(rest?: Record<string, unknown> | null) {
  const ctx = {
    connectionState: 'connected',
    clientId: 'c1',
    currentChannel: 'ch-1',
    send: jest.fn(),
    sendMessage: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    publish: jest.fn(),
    switchChannel: jest.fn(),
    disconnect: jest.fn(),
    reconnect: jest.fn(),
    lastError: null,
    sessionToken: null,
    onMessage: (_h: (m: GatewayMessage) => void) => () => {},
    ...(rest !== undefined ? { rest } : {}),
  } as unknown as GatewayContextValue;
  return ctx;
}

const wrapperFor = (ctx: GatewayContextValue) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <GatewayContext.Provider value={ctx}>{children}</GatewayContext.Provider>;
  };

function makeRest(initial: PinnedMessage[] = []) {
  let rows = [...initial];
  return {
    rows: () => rows,
    listPins: jest.fn(async (_channel: string) => [...rows]),
    pin: jest.fn(async (input: { channel: string; messageId: string; text: string; author: string }) => {
      const row = pinRow({
        channelId: input.channel,
        messageId: input.messageId,
        preview: input.text,
        author: input.author,
        pinnedBy: 'dev-bob',
      });
      rows = [row, ...rows.filter((r) => r.messageId !== input.messageId)];
      return row;
    }),
    unpin: jest.fn(async (_channel: string, messageId: string) => {
      rows = rows.filter((r) => r.messageId !== messageId);
    }),
  };
}

describe('reading a channel pins', () => {
  it('loads them for the channel it was given', async () => {
    const rest = makeRest([pinRow()]);
    const { result } = renderHook(() => usePins('ch-1'), { wrapper: wrapperFor(makeGateway(rest)) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pins).toHaveLength(1);
    expect(rest.listPins).toHaveBeenCalledWith('ch-1');
  });

  it('exposes the ids, which is what a message list marks itself with', async () => {
    const { result } = renderHook(() => usePins('ch-1'), {
      wrapper: wrapperFor(makeGateway(makeRest([pinRow()]))),
    });
    await waitFor(() => expect(result.current.pinnedIds.has('m1')).toBe(true));
  });

  // The previous channel's marker sitting on this channel's messages is worse
  // than no marker at all.
  it('drops the old channel pins the moment the channel changes', async () => {
    const rest = makeRest([pinRow()]);
    const { result, rerender } = renderHook(({ ch }: { ch: string }) => usePins(ch), {
      wrapper: wrapperFor(makeGateway(rest)),
      initialProps: { ch: 'ch-1' },
    });
    await waitFor(() => expect(result.current.pins).toHaveLength(1));

    rerender({ ch: 'ch-2' });
    expect(result.current.pins).toHaveLength(0);
  });

  it('does nothing at all without a channel', async () => {
    const rest = makeRest([pinRow()]);
    const { result } = renderHook(() => usePins(null), { wrapper: wrapperFor(makeGateway(rest)) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(rest.listPins).not.toHaveBeenCalled();
  });

  // A deployment that serves no pins should render an empty panel, not break.
  it('is empty and quiet when the gateway has no pin endpoint', async () => {
    const { result } = renderHook(() => usePins('ch-1'), { wrapper: wrapperFor(makeGateway(null)) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pins).toEqual([]);
    expect(result.current.error).toBeUndefined();
  });

  it('reports a failed read rather than pretending there are no pins', async () => {
    const rest = { ...makeRest(), listPins: jest.fn(async () => { throw new Error('HTTP 500'); }) };
    const { result } = renderHook(() => usePins('ch-1'), { wrapper: wrapperFor(makeGateway(rest)) });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
  });
});

describe('pinning', () => {
  // Pinning is deliberate; the marker has to appear under the click.
  it('shows the pin immediately, then takes the server version', async () => {
    const rest = makeRest();
    const { result } = renderHook(() => usePins('ch-1'), { wrapper: wrapperFor(makeGateway(rest)) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.pin({ messageId: 'm9', text: 'ship it', author: 'Hank' });
    });

    await waitFor(() => expect(result.current.pins[0]?.messageId).toBe('m9'));
    // The real pinnedBy, not the placeholder the optimistic row carried.
    expect(result.current.pins[0]?.pinnedBy).toBe('dev-bob');
  });

  it('pins into the channel it is looking at', async () => {
    const rest = makeRest();
    const { result } = renderHook(() => usePins('ch-7'), { wrapper: wrapperFor(makeGateway(rest)) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.pin({ messageId: 'm9', text: 't', author: 'H' });
    });
    expect(rest.pin.mock.calls[0]![0].channel).toBe('ch-7');
  });

  // Clicking twice must not render the message twice.
  it('does not duplicate a message that is already pinned', async () => {
    const rest = makeRest([pinRow({ messageId: 'm9' })]);
    const { result } = renderHook(() => usePins('ch-1'), { wrapper: wrapperFor(makeGateway(rest)) });
    await waitFor(() => expect(result.current.pins).toHaveLength(1));
    await act(async () => {
      await result.current.pin({ messageId: 'm9', text: 't', author: 'H' });
    });
    await waitFor(() => expect(result.current.pins).toHaveLength(1));
  });

  // The server's list is what everyone else sees, so a failed write has to be
  // rolled back rather than left on screen as a pin nobody else has.
  it('rolls the optimistic pin back when the write fails', async () => {
    const rest = { ...makeRest(), pin: jest.fn(async () => { throw new Error('HTTP 500'); }) };
    const { result } = renderHook(() => usePins('ch-1'), { wrapper: wrapperFor(makeGateway(rest)) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.pin({ messageId: 'm9', text: 't', author: 'H' });
    });

    await waitFor(() => expect(result.current.pins).toHaveLength(0));
    expect(result.current.error).toBeInstanceOf(Error);
  });
});

describe('unpinning', () => {
  it('removes it and tells the gateway', async () => {
    const rest = makeRest([pinRow({ messageId: 'm1' }), pinRow({ messageId: 'm2' })]);
    const { result } = renderHook(() => usePins('ch-1'), { wrapper: wrapperFor(makeGateway(rest)) });
    await waitFor(() => expect(result.current.pins).toHaveLength(2));

    await act(async () => { await result.current.unpin('m1'); });

    await waitFor(() => expect(result.current.pins.map((p) => p.messageId)).toEqual(['m2']));
    expect(rest.unpin).toHaveBeenCalledWith('ch-1', 'm1');
  });

  it('brings the pin back when the removal fails', async () => {
    const base = makeRest([pinRow({ messageId: 'm1' })]);
    const rest = { ...base, unpin: jest.fn(async () => { throw new Error('HTTP 500'); }) };
    const { result } = renderHook(() => usePins('ch-1'), { wrapper: wrapperFor(makeGateway(rest)) });
    await waitFor(() => expect(result.current.pins).toHaveLength(1));

    await act(async () => { await result.current.unpin('m1'); });

    await waitFor(() => expect(result.current.pins).toHaveLength(1));
    expect(result.current.error).toBeInstanceOf(Error);
  });
});

describe('what the error survives', () => {
  // Every write is followed by a reconciling read. An error the read could
  // clear would be gone before anyone saw it: the pin rolls back off the
  // screen with no explanation, which is worse than the write failing.
  it('keeps a write failure visible past the read that follows it', async () => {
    const base = makeRest();
    const rest = { ...base, pin: jest.fn(async () => { throw new Error('HTTP 500'); }) };
    const { result } = renderHook(() => usePins('ch-1'), { wrapper: wrapperFor(makeGateway(rest)) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.pin({ messageId: 'm9', text: 't', author: 'H' });
    });

    // The reconciling read succeeded — the list is right, the write still failed.
    await waitFor(() => expect(rest.listPins.mock.calls.length).toBeGreaterThan(1));
    expect(result.current.error?.message).toContain('500');
  });

  it('clears it once a write succeeds', async () => {
    let fail = true;
    const base = makeRest();
    const rest = {
      ...base,
      pin: jest.fn(async (input: any) => {
        if (fail) throw new Error('HTTP 500');
        return base.pin(input);
      }),
    };
    const { result } = renderHook(() => usePins('ch-1'), { wrapper: wrapperFor(makeGateway(rest)) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => { await result.current.pin({ messageId: 'm9', text: 't', author: 'H' }); });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));

    fail = false;
    await act(async () => { await result.current.pin({ messageId: 'm9', text: 't', author: 'H' }); });
    await waitFor(() => expect(result.current.error).toBeUndefined());
  });

  // A different conversation is a clean slate.
  it('clears it on a channel change', async () => {
    const base = makeRest();
    const rest = { ...base, pin: jest.fn(async () => { throw new Error('HTTP 500'); }) };
    const { result, rerender } = renderHook(({ ch }: { ch: string }) => usePins(ch), {
      wrapper: wrapperFor(makeGateway(rest)),
      initialProps: { ch: 'ch-1' },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.pin({ messageId: 'm9', text: 't', author: 'H' }); });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));

    rerender({ ch: 'ch-2' });
    expect(result.current.error).toBeUndefined();
  });
});
