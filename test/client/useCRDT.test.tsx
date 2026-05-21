/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useCRDT.test.tsx
//
// Lifted from frontend/src/hooks/__tests__/useCRDT.test.ts.
// Vitest → Jest conversion (vi.* → jest.*).

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import { encodeStateAsUpdate } from 'yjs';
import type { ConnectionState, GatewayMessage } from '../../src/client/types';

// ---------------------------------------------------------------------------
// Test helpers — simulate the sendMessage / onMessage contract from useWebSocket
// ---------------------------------------------------------------------------

type MessageHandler = (msg: GatewayMessage) => void;

function makeCRDTOptions(overrides: {
  connectionState?: ConnectionState;
  currentChannel?: string;
  sendMessageMock?: ReturnType<typeof jest.fn>;
} = {}) {
  const sendMessage = (overrides.sendMessageMock ?? jest.fn()) as unknown as ((msg: Record<string, unknown>) => void) & ReturnType<typeof jest.fn>;
  const handlers: MessageHandler[] = [];

  const onMessage = (handler: MessageHandler) => {
    handlers.push(handler);
    return () => {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    };
  };

  const dispatch = (msg: GatewayMessage) => handlers.forEach((h) => h(msg));

  return {
    sendMessage,
    onMessage,
    dispatch,
    connectionState: overrides.connectionState ?? ('connected' as ConnectionState),
    currentChannel: overrides.currentChannel ?? 'doc-1',
  };
}

// Helper to build a base64 Y.js snapshot from a string
function makeSnapshot(text: string): string {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, text);
  const bytes = encodeStateAsUpdate(doc);
  return Buffer.from(bytes).toString('base64');
}

// ---------------------------------------------------------------------------
// Import hook
// ---------------------------------------------------------------------------

import { useCRDT } from '../../src/client/useCRDT';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useCRDT', () => {
  // -------------------------------------------------------------------------
  // 1. Subscribe on connect
  // -------------------------------------------------------------------------
  describe('subscribe on connect', () => {
    it('sends subscribe message when connectionState is connected and channel is set', () => {
      const opts = makeCRDTOptions();
      renderHook(() => useCRDT(opts));

      expect(opts.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          service: 'crdt',
          action: 'subscribe',
          channel: 'doc-1',
        })
      );
    });

    it('does NOT send subscribe when connectionState is disconnected', () => {
      const opts = makeCRDTOptions({ connectionState: 'disconnected' });
      renderHook(() => useCRDT(opts));

      expect(opts.sendMessage).not.toHaveBeenCalled();
    });

    it('does NOT send subscribe when connectionState is connecting', () => {
      const opts = makeCRDTOptions({ connectionState: 'connecting' });
      renderHook(() => useCRDT(opts));

      expect(opts.sendMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 4. crdt:snapshot — restores document content
  // -------------------------------------------------------------------------
  describe('crdt:snapshot — restores document content', () => {
    it('sets content from snapshot binary data', () => {
      const opts = makeCRDTOptions();
      const { result } = renderHook(() => useCRDT(opts));

      const snapshot = makeSnapshot('hello');

      act(() => {
        opts.dispatch({
          type: 'crdt:snapshot',
          channel: 'doc-1',
          snapshot,
        });
      });

      expect(result.current.content).toBe('hello');
    });

    it('handles empty/missing snapshot field gracefully (content stays empty string)', () => {
      const opts = makeCRDTOptions();
      const { result } = renderHook(() => useCRDT(opts));

      act(() => {
        opts.dispatch({
          type: 'crdt:snapshot',
          channel: 'doc-1',
          snapshot: undefined,
        });
      });

      expect(result.current.content).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // 5. crdt:update — applies incoming remote update
  // -------------------------------------------------------------------------
  describe('crdt:update — applies incoming remote update', () => {
    it('applies incoming update and updates content', () => {
      const opts = makeCRDTOptions();
      const { result } = renderHook(() => useCRDT(opts));

      const update = makeSnapshot('world');

      act(() => {
        opts.dispatch({
          type: 'crdt:update',
          channel: 'doc-1',
          update,
          clientId: 'remote',
        });
      });

      expect(result.current.content).toBe('world');
    });
  });

  // -------------------------------------------------------------------------
  // 6. crdt:update for different channel is ignored
  // -------------------------------------------------------------------------
  describe('channel filtering', () => {
    it('ignores crdt:update for a different channel', () => {
      const opts = makeCRDTOptions({ currentChannel: 'doc-1' });
      const { result } = renderHook(() => useCRDT(opts));

      const update = makeSnapshot('wrong channel data');

      act(() => {
        opts.dispatch({
          type: 'crdt:update',
          channel: 'other',
          update,
          clientId: 'remote',
        });
      });

      expect(result.current.content).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // 7 & 8. applyLocalEdit
  // -------------------------------------------------------------------------
  describe('applyLocalEdit', () => {
    it('sends update to gateway with service:crdt action:update and non-empty update field', () => {
      const opts = makeCRDTOptions();
      const { result } = renderHook(() => useCRDT(opts));
      const sendMessage = opts.sendMessage as ReturnType<typeof jest.fn>;

      // Clear the subscribe call
      sendMessage.mockClear();

      act(() => {
        result.current.applyLocalEdit('hello world');
      });

      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          service: 'crdt',
          action: 'update',
          channel: 'doc-1',
        })
      );

      const call = sendMessage.mock.calls[0][0] as Record<string, unknown>;
      expect(typeof call.update).toBe('string');
      expect((call.update as string).length).toBeGreaterThan(0);
    });

    it('updates content state after applyLocalEdit', () => {
      const opts = makeCRDTOptions();
      const { result } = renderHook(() => useCRDT(opts));

      act(() => {
        result.current.applyLocalEdit('my text');
      });

      expect(result.current.content).toBe('my text');
    });

    it('clears document content when applyLocalEdit is called with empty string', () => {
      const opts = makeCRDTOptions();
      const { result } = renderHook(() => useCRDT(opts));

      // First set some content
      act(() => {
        result.current.applyLocalEdit('some content');
      });

      expect(result.current.content).toBe('some content');

      // Now clear it
      act(() => {
        result.current.applyLocalEdit('');
      });

      expect(result.current.content).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // 9. channel change — resets content and re-subscribes
  // -------------------------------------------------------------------------
  describe('channel change', () => {
    it('clears content and re-subscribes when channel changes', () => {
      const opts = makeCRDTOptions({ currentChannel: 'doc-1' });
      const sendMessage = opts.sendMessage as ReturnType<typeof jest.fn>;

      const { result, rerender } = renderHook(
        ({ channel }: { channel: string }) =>
          useCRDT({ ...opts, currentChannel: channel }),
        { initialProps: { channel: 'doc-1' } }
      );

      // Receive snapshot on doc-1 to set some content
      act(() => {
        opts.dispatch({
          type: 'crdt:snapshot',
          channel: 'doc-1',
          snapshot: makeSnapshot('initial content'),
        });
      });

      expect(result.current.content).toBe('initial content');

      sendMessage.mockClear();

      // Switch to doc-2
      rerender({ channel: 'doc-2' });

      expect(result.current.content).toBe('');

      const calls = sendMessage.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      const unsubscribeCall = calls.find(
        (c) => c.action === 'unsubscribe' && c.channel === 'doc-1'
      );
      const subscribeCall = calls.find(
        (c) => c.action === 'subscribe' && c.channel === 'doc-2'
      );

      expect(unsubscribeCall).toBeDefined();
      expect(subscribeCall).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // 10. unsubscribe on unmount
  // -------------------------------------------------------------------------
  describe('unsubscribe on unmount', () => {
    it('sends unsubscribe when hook unmounts', () => {
      const opts = makeCRDTOptions();
      const { unmount } = renderHook(() => useCRDT(opts));

      (opts.sendMessage as ReturnType<typeof jest.fn>).mockClear();

      unmount();

      expect(opts.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          service: 'crdt',
          action: 'unsubscribe',
          channel: 'doc-1',
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // 11. return shape
  // -------------------------------------------------------------------------
  describe('return shape', () => {
    it('returns content string and applyLocalEdit function', () => {
      const opts = makeCRDTOptions();
      const { result } = renderHook(() => useCRDT(opts));

      expect(typeof result.current.content).toBe('string');
      expect(typeof result.current.applyLocalEdit).toBe('function');
    });

    it('starts with empty content string', () => {
      const opts = makeCRDTOptions();
      const { result } = renderHook(() => useCRDT(opts));

      expect(result.current.content).toBe('');
    });
  });
});
