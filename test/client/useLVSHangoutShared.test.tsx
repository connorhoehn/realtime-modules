/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useLVSHangoutShared.test.tsx
//
// useLVSHangoutShared — context-shared variant. Verifies the load-bearing
// invariant: when N consumers read via useLVSHangoutShared() under a
// single LVSHangoutSessionProvider, the underlying useLVSHangout hook
// runs EXACTLY ONCE — not N times.
//
// This is the property that closes the duplicate-WS-subscription cost
// the gateway demo flagged on 2026-06-04. The hook itself opens its own
// discovery WS in a useEffect; if it ran per-consumer, each consumer
// would open its own WS. The provider boundary collapses N consumers
// onto one underlying call.
//
// We jest.mock useLVSHangout so the test is self-contained — exercising
// the provider's contract, not the underlying SDK's runtime behaviour.

import React from 'react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { render, renderHook } from '@testing-library/react';

// Mock the underlying hook so we can assert call count. The mock
// returns a stable session object so consumers can do identity checks.
const mockSession = {
  participants: [],
  isJoined: false,
  isScreenSharing: false,
  isCameraEnabled: true,
  error: null,
  connectionState: 'idle' as const,
  toggleMute: jest.fn(),
  toggleCamera: jest.fn(),
  enableCamera: jest.fn(),
  disableCamera: jest.fn(),
  startScreenShare: jest.fn(),
  stopScreenShare: jest.fn(),
  leave: jest.fn(),
};
const useLVSHangoutMock = jest.fn((_opts: unknown) => mockSession);

jest.mock('../../src/client/video/useLVSHangout', () => ({
  useLVSHangout: (opts: unknown) => useLVSHangoutMock(opts),
}));

// Import AFTER mock declaration.
import {
  LVSHangoutSessionProvider,
  LVSHangoutSessionContext,
  useLVSHangoutShared,
} from '../../src/client/video/useLVSHangoutShared';

const baseOpts = {
  stageToken: 'eyJ.fake.token',
  participantId: 'p-1',
  userId: 'u-1',
};

beforeEach(() => {
  useLVSHangoutMock.mockClear();
});

describe('useLVSHangoutShared', () => {
  it('throws a clear error when called outside a provider', () => {
    expect(() => renderHook(() => useLVSHangoutShared())).toThrow(
      /must be called inside <LVSHangoutSessionProvider>/,
    );
  });

  it('mounts the underlying useLVSHangout exactly once per provider', () => {
    function ChildA() {
      useLVSHangoutShared();
      return <span>A</span>;
    }
    function ChildB() {
      useLVSHangoutShared();
      return <span>B</span>;
    }
    function ChildC() {
      useLVSHangoutShared();
      return <span>C</span>;
    }
    render(
      <LVSHangoutSessionProvider opts={baseOpts as any}>
        <ChildA />
        <ChildB />
        <ChildC />
      </LVSHangoutSessionProvider>,
    );
    // The PROPERTY this hook exists to guarantee: one underlying mount,
    // not one per consumer.
    expect(useLVSHangoutMock).toHaveBeenCalledTimes(1);
    expect(useLVSHangoutMock).toHaveBeenCalledWith(baseOpts);
  });

  it('returns the same identity to every consumer (zero-cost shared session)', () => {
    let aValue: unknown = null;
    let bValue: unknown = null;
    function ChildA() {
      aValue = useLVSHangoutShared();
      return null;
    }
    function ChildB() {
      bValue = useLVSHangoutShared();
      return null;
    }
    render(
      <LVSHangoutSessionProvider opts={baseOpts as any}>
        <ChildA />
        <ChildB />
      </LVSHangoutSessionProvider>,
    );
    // Strict-identity — the value is the same object reference for
    // every consumer. Callers that compare via `===` get true.
    expect(aValue).toBe(bValue);
    expect(aValue).toBe(mockSession);
  });

  it('LVSHangoutSessionContext is the React context the provider seeds', () => {
    // Allow advanced consumers to bypass useLVSHangoutShared and read
    // the context directly (e.g. higher-order components). Smoke this
    // by reading via useContext directly.
    let observed: unknown = null;
    function Probe() {
      observed = React.useContext(LVSHangoutSessionContext);
      return null;
    }
    render(
      <LVSHangoutSessionProvider opts={baseOpts as any}>
        <Probe />
      </LVSHangoutSessionProvider>,
    );
    expect(observed).toBe(mockSession);
  });

  it('re-rendering the provider with stable opts does not re-mount the hook (memoization respected)', () => {
    const { rerender } = render(
      <LVSHangoutSessionProvider opts={baseOpts as any}>
        <span>once</span>
      </LVSHangoutSessionProvider>,
    );
    expect(useLVSHangoutMock).toHaveBeenCalledTimes(1);
    rerender(
      <LVSHangoutSessionProvider opts={baseOpts as any}>
        <span>twice</span>
      </LVSHangoutSessionProvider>,
    );
    // React re-renders the provider; useLVSHangout is called per render
    // (it's a hook, not a one-shot mount). The total call count goes up.
    // What we care about is that EACH render is one call, not N — i.e.
    // the consumers below don't add to the call count.
    function NestedConsumer() {
      useLVSHangoutShared();
      return null;
    }
    const callCountBeforeConsumers = useLVSHangoutMock.mock.calls.length;
    rerender(
      <LVSHangoutSessionProvider opts={baseOpts as any}>
        <NestedConsumer />
        <NestedConsumer />
        <NestedConsumer />
      </LVSHangoutSessionProvider>,
    );
    // Adding 3 consumers added 1 call (one for the provider re-render),
    // not 3. This is the property under test.
    expect(useLVSHangoutMock.mock.calls.length).toBe(callCountBeforeConsumers + 1);
  });
});
