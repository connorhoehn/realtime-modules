/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useYjsDoc.test.tsx
//
// Lifted from frontend/src/hooks/__tests__/useYjsDoc.test.ts.
// Vitest → Jest conversion (vi.* → jest.*).

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react';
import type { ConnectionState, GatewayMessage, UseWebSocketReturn } from '../../src/client/types';
import { useYjsDoc } from '../../src/client/useYjsDoc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MessageHandler = (msg: GatewayMessage) => void;

function makeOptions(documentId = 'doc-1') {
  const handlers: MessageHandler[] = [];
  const sendMessage = jest.fn();

  const ws: UseWebSocketReturn = {
    connectionState: 'connected' as ConnectionState,
    lastError: null,
    sessionToken: null,
    clientId: null,
    currentChannel: '',
    switchChannel: jest.fn(),
    sendMessage: sendMessage as unknown as UseWebSocketReturn['sendMessage'],
    disconnect: jest.fn(),
    reconnect: jest.fn(),
  };

  const onMessage = (h: MessageHandler) => {
    handlers.push(h);
    return () => {
      const idx = handlers.indexOf(h);
      if (idx !== -1) handlers.splice(idx, 1);
    };
  };

  const dispatch = (msg: GatewayMessage) => handlers.forEach((h) => h(msg));

  return { documentId, ws, sendMessage, onMessage, dispatch };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('useYjsDoc', () => {
  it('creates a Y.Doc and GatewayProvider on mount', () => {
    const opts = makeOptions();
    const { result } = renderHook(() =>
      useYjsDoc({
        documentId: opts.documentId,
        ws: opts.ws,
        onMessage: opts.onMessage,
      }),
    );

    expect(result.current.ydoc).not.toBeNull();
    expect(result.current.provider).not.toBeNull();
    expect(result.current.synced).toBe(false);
  });

  it('sends subscribe message on mount', () => {
    const opts = makeOptions();
    renderHook(() =>
      useYjsDoc({
        documentId: opts.documentId,
        ws: opts.ws,
        onMessage: opts.onMessage,
      }),
    );

    expect(opts.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'crdt',
        action: 'subscribe',
        channel: 'doc:doc-1',
      }),
    );
  });

  it('flips synced=true after provider emits synced', () => {
    const opts = makeOptions();
    const { result } = renderHook(() =>
      useYjsDoc({
        documentId: opts.documentId,
        ws: opts.ws,
        onMessage: opts.onMessage,
      }),
    );

    expect(result.current.synced).toBe(false);

    act(() => {
      result.current.provider!.emit('synced', [true]);
    });

    expect(result.current.synced).toBe(true);
  });

  it('unsubscribes and destroys provider/doc on unmount', () => {
    const opts = makeOptions();
    const { result, unmount } = renderHook(() =>
      useYjsDoc({
        documentId: opts.documentId,
        ws: opts.ws,
        onMessage: opts.onMessage,
      }),
    );

    const provider = result.current.provider!;
    const ydoc = result.current.ydoc!;
    const destroyProvider = jest.spyOn(provider, 'destroy');
    const destroyDoc = jest.spyOn(ydoc, 'destroy');

    opts.sendMessage.mockClear();

    act(() => {
      unmount();
    });

    expect(destroyProvider).toHaveBeenCalledTimes(1);
    expect(destroyDoc).toHaveBeenCalledTimes(1);
    expect(opts.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'crdt',
        action: 'unsubscribe',
        channel: 'doc:doc-1',
      }),
    );
  });

  it('resubscribes when a session message arrives', () => {
    const opts = makeOptions();
    renderHook(() =>
      useYjsDoc({
        documentId: opts.documentId,
        ws: opts.ws,
        onMessage: opts.onMessage,
      }),
    );

    opts.sendMessage.mockClear();

    act(() => {
      opts.dispatch({
        type: 'session',
        clientId: 'c1',
        sessionToken: 't',
      } as unknown as GatewayMessage);
    });

    expect(opts.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'crdt',
        action: 'subscribe',
        channel: 'doc:doc-1',
      }),
    );
  });
});
