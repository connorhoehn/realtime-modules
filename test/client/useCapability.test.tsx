/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useCapability.test.tsx
//
// Exercises the useCapability hook via a mock GatewayContext. Covers:
//   - Capability enabled: REST response { enabled: true } → enabled=true, isLoading=false
//   - Capability disabled: REST response { enabled: false } → enabled=false
//   - REST endpoint 404s → optimistic fallback: enabled=true, isLoading=false, no error
//   - REST throws non-404 error → error set, isLoading=false, enabled=false
//   - No REST surface wired → optimistic enabled=true immediately
//   - capability:updated frame arrives (matching name) → state updates in place
//   - capability:updated frame with different name → ignored
//   - capability:updated with channel scope: matching channel updates, mismatched ignored
//   - isLoading starts true and transitions to false after REST resolves
//   - metadata + version fields forwarded from REST response

import React from 'react';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { GatewayContext } from '../../src/client/GatewaySocketProvider';
import type { GatewayContextValue } from '../../src/client/GatewaySocketProvider';
import type { GatewayMessage } from '../../src/client/types';
import { useCapability } from '../../src/client/useCapability';

// ---------------------------------------------------------------------------
// Helpers: fake GatewayContext
// ---------------------------------------------------------------------------

interface GetCapabilityFn {
  (name: string, channel?: string): Promise<{
    enabled: boolean;
    version?: string;
    metadata?: Record<string, unknown>;
  }>;
}

function makeGatewayContext(getCapabilityImpl?: GetCapabilityFn) {
  const handlers = new Set<(msg: GatewayMessage) => void>();

  // Typed as a plain object so we can attach an optional `rest` extension
  // field without changing the GatewayContextValue interface.
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
    // Optional REST shim — wired when getCapabilityImpl is provided.
    ...(getCapabilityImpl
      ? { rest: { getCapability: getCapabilityImpl } }
      : {}),
  } as unknown as GatewayContextValue;

  const emit = (msg: GatewayMessage) => {
    for (const h of handlers) h(msg);
  };

  return { ctx, emit };
}

function makeWrapper(ctx: GatewayContextValue) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <GatewayContext.Provider value={ctx}>
        {children}
      </GatewayContext.Provider>
    );
  };
}

function emitCapabilityUpdated(
  emit: (msg: GatewayMessage) => void,
  payload: {
    name: string;
    enabled: boolean;
    channel?: string;
    version?: string;
    metadata?: Record<string, unknown>;
  },
) {
  emit({
    type: 'capability:updated',
    payload,
  } as unknown as GatewayMessage);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.runAllTimers();
  jest.useRealTimers();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useCapability', () => {
  it('starts with isLoading=true and enabled=false before REST resolves', async () => {
    // getCapability never resolves — we inspect the pre-resolution state.
    let resolveCapability!: (v: { enabled: boolean }) => void;
    const pending = new Promise<{ enabled: boolean }>((res) => {
      resolveCapability = res;
    });

    const { ctx } = makeGatewayContext(async () => pending);
    const { result } = renderHook(() => useCapability('chat'), {
      wrapper: makeWrapper(ctx),
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.enabled).toBe(false);
    expect(result.current.capability).toBeNull();

    // Resolve so we don't leave a dangling promise.
    resolveCapability({ enabled: true });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('enabled=true when REST responds { enabled: true }', async () => {
    const { ctx } = makeGatewayContext(async () => ({ enabled: true }));
    const { result } = renderHook(() => useCapability('chat'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.enabled).toBe(true);
    expect(result.current.capability?.name).toBe('chat');
    expect(result.current.error).toBeUndefined();
  });

  it('enabled=false when REST responds { enabled: false }', async () => {
    const { ctx } = makeGatewayContext(async () => ({ enabled: false }));
    const { result } = renderHook(() => useCapability('chat'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.enabled).toBe(false);
    expect(result.current.capability?.enabled).toBe(false);
  });

  it('version and metadata fields are forwarded from REST response', async () => {
    const { ctx } = makeGatewayContext(async () => ({
      enabled: true,
      version: '1.2.3',
      metadata: { maxMessages: 500, tier: 'pro' },
    }));
    const { result } = renderHook(() => useCapability('chat'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.capability?.version).toBe('1.2.3');
    expect(result.current.capability?.metadata).toEqual({ maxMessages: 500, tier: 'pro' });
  });

  it('channel is forwarded onto the capability descriptor', async () => {
    const getCapability = jest.fn(async (_n: string, _ch?: string) => ({ enabled: true }));
    const { ctx } = makeGatewayContext(getCapability as unknown as GetCapabilityFn);
    const { result } = renderHook(() => useCapability('chat', 'room:abc'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.capability?.channel).toBe('room:abc');
    expect(getCapability).toHaveBeenCalledWith('chat', 'room:abc');
  });

  it('REST 404 → optimistic fallback: enabled=true, no error', async () => {
    const err404 = Object.assign(new Error('Not Found'), { status: 404 });
    const { ctx } = makeGatewayContext(async () => { throw err404; });
    const { result } = renderHook(() => useCapability('chat'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.enabled).toBe(true);
    expect(result.current.error).toBeUndefined();
    expect(result.current.capability?.name).toBe('chat');
  });

  it('REST non-404 error → error set, enabled=false', async () => {
    const err500 = Object.assign(new Error('Internal Server Error'), { status: 500 });
    const { ctx } = makeGatewayContext(async () => { throw err500; });
    const { result } = renderHook(() => useCapability('chat'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.enabled).toBe(false);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('Internal Server Error');
  });

  it('no REST surface wired → optimistic enabled=true immediately', async () => {
    // No getCapabilityImpl passed → ctx has no `rest` property.
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(() => useCapability('presence'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.enabled).toBe(true);
    expect(result.current.capability?.name).toBe('presence');
    expect(result.current.error).toBeUndefined();
  });

  it('capability:updated frame updates state in place', async () => {
    const { ctx, emit } = makeGatewayContext(async () => ({ enabled: false }));
    const { result } = renderHook(() => useCapability('chat'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(false);

    act(() => {
      emitCapabilityUpdated(emit, { name: 'chat', enabled: true, version: '2.0.0' });
    });

    expect(result.current.enabled).toBe(true);
    expect(result.current.capability?.version).toBe('2.0.0');
  });

  it('capability:updated frame with different name is ignored', async () => {
    const { ctx, emit } = makeGatewayContext(async () => ({ enabled: false }));
    const { result } = renderHook(() => useCapability('chat'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      emitCapabilityUpdated(emit, { name: 'presence', enabled: true });
    });

    // Still disabled — frame was for 'presence', not 'chat'.
    expect(result.current.enabled).toBe(false);
  });

  it('capability:updated with matching channel scope updates state', async () => {
    const { ctx, emit } = makeGatewayContext(async () => ({ enabled: false }));
    const { result } = renderHook(() => useCapability('chat', 'room:abc'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      emitCapabilityUpdated(emit, { name: 'chat', enabled: true, channel: 'room:abc' });
    });

    expect(result.current.enabled).toBe(true);
  });

  it('capability:updated with mismatched channel is ignored', async () => {
    const { ctx, emit } = makeGatewayContext(async () => ({ enabled: false }));
    const { result } = renderHook(() => useCapability('chat', 'room:abc'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      emitCapabilityUpdated(emit, { name: 'chat', enabled: true, channel: 'room:xyz' });
    });

    // Still disabled — frame was scoped to a different channel.
    expect(result.current.enabled).toBe(false);
  });

  it('capability:updated sets isLoading=false when it arrives before REST resolves', async () => {
    // Slow REST — never resolves during this test.
    let resolveCapability!: (v: { enabled: boolean }) => void;
    const pending = new Promise<{ enabled: boolean }>((res) => {
      resolveCapability = res;
    });

    const { ctx, emit } = makeGatewayContext(async () => pending);
    const { result } = renderHook(() => useCapability('chat'), {
      wrapper: makeWrapper(ctx),
    });

    // Before any resolution: still loading.
    expect(result.current.isLoading).toBe(true);

    // A push frame arrives before the REST resolves.
    act(() => {
      emitCapabilityUpdated(emit, { name: 'chat', enabled: true });
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.enabled).toBe(true);

    // Resolve so we don't leave a dangling promise.
    resolveCapability({ enabled: false });
    await waitFor(() => {
      // REST result wins only if the hook isn't cancelled yet — but since the
      // component is still mounted both may update. The important thing is
      // that isLoading stays false and the hook doesn't throw.
      expect(result.current.isLoading).toBe(false);
    });
  });
});
