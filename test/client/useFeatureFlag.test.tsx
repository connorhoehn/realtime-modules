/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useFeatureFlag.test.tsx
//
// Exercises the useFeatureFlag hook via a mock GatewayContext. Covers:
//   - Default value used when no REST surface is wired
//   - REST returns { enabled: true } → state reflects
//   - REST returns { enabled: false } → state reflects
//   - Variant returned + accessible on result
//   - metadata returned + accessible on result
//   - feature-flag:updated frame → state updates reactively
//   - feature-flag:updated frame for different flag name → ignored
//   - isLoading starts true, transitions to false after REST resolves
//   - Subscription cleanup on unmount (unsubscribe called)
//   - REST throws (any error) → falls back to defaultValue gracefully

import React from 'react';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { GatewayContext } from '../../src/client/GatewaySocketProvider';
import type { GatewayContextValue } from '../../src/client/GatewaySocketProvider';
import type { GatewayMessage } from '../../src/client/types';
import { useFeatureFlag } from '../../src/client/useFeatureFlag';

// ---------------------------------------------------------------------------
// Helpers: fake GatewayContext
// ---------------------------------------------------------------------------

interface GetFeatureFlagFn {
  (name: string): Promise<{
    enabled: boolean;
    variant?: string;
    metadata?: Record<string, unknown>;
  }>;
}

function makeGatewayContext(getFeatureFlagImpl?: GetFeatureFlagFn) {
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
    // Optional REST shim — wired when getFeatureFlagImpl is provided.
    ...(getFeatureFlagImpl
      ? { rest: { getFeatureFlag: getFeatureFlagImpl } }
      : {}),
  } as unknown as GatewayContextValue;

  const emit = (msg: GatewayMessage) => {
    for (const h of handlers) h(msg);
  };

  return { ctx, emit, handlers };
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

function emitFlagUpdated(
  emit: (msg: GatewayMessage) => void,
  payload: {
    name: string;
    enabled: boolean;
    variant?: string;
    metadata?: Record<string, unknown>;
  },
) {
  emit({
    type: 'feature-flag:updated',
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

describe('useFeatureFlag', () => {
  it('starts with isLoading=true and enabled=defaultValue (false) before REST resolves', async () => {
    let resolveFlag!: (v: { enabled: boolean }) => void;
    const pending = new Promise<{ enabled: boolean }>((res) => {
      resolveFlag = res;
    });

    const { ctx } = makeGatewayContext(async () => pending);
    const { result } = renderHook(() => useFeatureFlag('new-ui'), {
      wrapper: makeWrapper(ctx),
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.enabled).toBe(false);

    // Resolve so we don't leave a dangling promise.
    resolveFlag({ enabled: true });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('defaultValue=true used as initial enabled and fallback', async () => {
    let resolveFlag!: (v: { enabled: boolean }) => void;
    const pending = new Promise<{ enabled: boolean }>((res) => {
      resolveFlag = res;
    });

    const { ctx } = makeGatewayContext(async () => pending);
    const { result } = renderHook(() => useFeatureFlag('kill-switch', true), {
      wrapper: makeWrapper(ctx),
    });

    // Custom defaultValue applied while loading.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.enabled).toBe(true);

    resolveFlag({ enabled: false });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(false);
  });

  it('enabled=true when REST responds { enabled: true }', async () => {
    const { ctx } = makeGatewayContext(async () => ({ enabled: true }));
    const { result } = renderHook(() => useFeatureFlag('new-ui'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(true);
  });

  it('enabled=false when REST responds { enabled: false }', async () => {
    const { ctx } = makeGatewayContext(async () => ({ enabled: false }));
    const { result } = renderHook(() => useFeatureFlag('new-ui'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(false);
  });

  it('variant returned and accessible', async () => {
    const { ctx } = makeGatewayContext(async () => ({
      enabled: true,
      variant: 'variant-a',
    }));
    const { result } = renderHook(() => useFeatureFlag('checkout-flow'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.variant).toBe('variant-a');
    expect(result.current.enabled).toBe(true);
  });

  it('metadata returned and accessible', async () => {
    const { ctx } = makeGatewayContext(async () => ({
      enabled: true,
      metadata: { rolloutPercent: 25, tier: 'beta' },
    }));
    const { result } = renderHook(() => useFeatureFlag('new-ui'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.metadata).toEqual({ rolloutPercent: 25, tier: 'beta' });
  });

  it('no REST surface wired → defaultValue used, isLoading=false', async () => {
    // No getFeatureFlagImpl passed → ctx has no `rest` property.
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(() => useFeatureFlag('new-ui'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(false);
  });

  it('REST 404 → falls back to defaultValue gracefully', async () => {
    const err404 = Object.assign(new Error('Not Found'), { status: 404 });
    const { ctx } = makeGatewayContext(async () => { throw err404; });
    const { result } = renderHook(() => useFeatureFlag('new-ui'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(false);
    // No error surface on this hook — falls back silently.
  });

  it('REST 500 → falls back to defaultValue gracefully', async () => {
    const err500 = Object.assign(new Error('Internal Server Error'), { status: 500 });
    const { ctx } = makeGatewayContext(async () => { throw err500; });
    const { result } = renderHook(() => useFeatureFlag('kill-switch', true), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Falls back to defaultValue=true on any REST error.
    expect(result.current.enabled).toBe(true);
  });

  it('feature-flag:updated frame → state updates reactively', async () => {
    const { ctx, emit } = makeGatewayContext(async () => ({ enabled: false }));
    const { result } = renderHook(() => useFeatureFlag('new-ui'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.enabled).toBe(false);

    act(() => {
      emitFlagUpdated(emit, { name: 'new-ui', enabled: true, variant: 'variant-b' });
    });

    expect(result.current.enabled).toBe(true);
    expect(result.current.variant).toBe('variant-b');
    expect(result.current.isLoading).toBe(false);
  });

  it('feature-flag:updated frame for different flag name → ignored', async () => {
    const { ctx, emit } = makeGatewayContext(async () => ({ enabled: false }));
    const { result } = renderHook(() => useFeatureFlag('new-ui'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      emitFlagUpdated(emit, { name: 'other-flag', enabled: true });
    });

    // State unchanged — frame was for a different flag.
    expect(result.current.enabled).toBe(false);
  });

  it('feature-flag:updated sets isLoading=false when it arrives before REST resolves', async () => {
    let resolveFlag!: (v: { enabled: boolean }) => void;
    const pending = new Promise<{ enabled: boolean }>((res) => {
      resolveFlag = res;
    });

    const { ctx, emit } = makeGatewayContext(async () => pending);
    const { result } = renderHook(() => useFeatureFlag('new-ui'), {
      wrapper: makeWrapper(ctx),
    });

    expect(result.current.isLoading).toBe(true);

    // Push frame arrives before REST resolves.
    act(() => {
      emitFlagUpdated(emit, { name: 'new-ui', enabled: true });
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.enabled).toBe(true);

    // Resolve so we don't leave a dangling promise.
    resolveFlag({ enabled: false });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('subscription cleanup on unmount — handler removed from set', async () => {
    const { ctx, handlers } = makeGatewayContext(async () => ({ enabled: true }));
    const { result, unmount } = renderHook(() => useFeatureFlag('new-ui'), {
      wrapper: makeWrapper(ctx),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(handlers.size).toBe(1);

    unmount();

    expect(handlers.size).toBe(0);
  });
});
