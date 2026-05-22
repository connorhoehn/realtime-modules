/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useVideoHangout.test.tsx
//
// Exercises useVideoHangout via a mock GatewayContext.
// Covers:
//   - start() emits correct outbound frame + resolves on videohangout:created
//   - join() emits correct outbound frame + resolves on videohangout:joined
//   - session + joinToken state populated from gateway frames
//   - participant list populated from joined frame + updated by participant/left frames
//   - media toggle frames update participant videoOn/audioOn
//   - leave() emits leave frame + clears session/participants
//   - end() emits end frame + clears session/participants
//   - toggleVideo() / toggleAudio() emit correct frames
//   - videohangout:ended clears all state
//   - videohangout:error rejects pending start/join promise
//   - channel change resets state

import React from 'react';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { GatewayContext } from '../../src/client/GatewaySocketProvider';
import type { GatewayContextValue } from '../../src/client/GatewaySocketProvider';
import type { GatewayMessage } from '../../src/client/types';
import { useVideoHangout } from '../../src/client/useVideoHangout';

// ---------------------------------------------------------------------------
// Fake GatewayContext
// ---------------------------------------------------------------------------

function makeGatewayContext() {
  const sent: Record<string, unknown>[] = [];
  const handlers = new Set<(msg: GatewayMessage) => void>();

  const ctx: GatewayContextValue = {
    connectionState: 'connected',
    lastError: null,
    sessionToken: null,
    clientId: 'client-1',
    currentChannel: 'ch-1',
    switchChannel: jest.fn() as unknown as (c: string) => void,
    sendMessage: jest.fn() as unknown as (msg: Record<string, unknown>) => void,
    disconnect: jest.fn() as unknown as () => void,
    reconnect: jest.fn() as unknown as () => void,
    send: jest.fn((msg: Record<string, unknown>) => {
      sent.push(msg);
    }) as unknown as (msg: Record<string, unknown>) => void,
    subscribe: jest.fn() as unknown as (ch: string) => void,
    unsubscribe: jest.fn() as unknown as (ch: string) => void,
    publish: jest.fn() as unknown as (ch: string, frame: Record<string, unknown>) => void,
    onMessage: (handler: (msg: GatewayMessage) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };

  const emit = (msg: GatewayMessage) => {
    for (const h of handlers) h(msg);
  };

  return { ctx, sent, emit };
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

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const SESSION = { id: 'sess-001', type: 'hangout', createdAt: '2026-05-21T10:00:00Z' };
const PARTICIPANT_HOST = {
  clientId: 'client-host',
  displayName: 'Alice',
  role: 'host' as const,
  videoOn: true,
  audioOn: true,
  joinedAt: '2026-05-21T10:00:00Z',
};
const PARTICIPANT_USER = {
  clientId: 'client-1',
  displayName: 'Bob',
  role: 'participant' as const,
  videoOn: true,
  audioOn: true,
  joinedAt: '2026-05-21T10:01:00Z',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useVideoHangout', () => {
  it('initial state is null session, empty participants, null joinToken', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });
    expect(result.current.session).toBeNull();
    expect(result.current.participants).toEqual([]);
    expect(result.current.joinToken).toBeNull();
  });

  it('start() emits correct outbound frame', async () => {
    const { ctx, sent, emit } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    let resolved = false;
    act(() => {
      result.current.start({ type: 'hangout', metadata: { roomName: 'Daily standup' } })
        .then(() => { resolved = true; });
    });

    const frame = sent.find((s) => s.action === 'start');
    expect(frame).toBeDefined();
    expect(frame!.service).toBe('videohangout');
    expect(frame!.channel).toBe('ch-1');
    expect(frame!.type).toBe('hangout');
    expect((frame!.metadata as Record<string, unknown>).roomName).toBe('Daily standup');

    // Resolve the promise by emitting the created frame.
    act(() => {
      emit({
        type: 'videohangout:created',
        channel: 'ch-1',
        session: SESSION,
        joinToken: 'tok-host-abc',
      });
    });

    await waitFor(() => expect(resolved).toBe(true));
  });

  it('videohangout:created populates session + joinToken', async () => {
    const { ctx, sent, emit } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => { void result.current.start(); });

    act(() => {
      emit({
        type: 'videohangout:created',
        channel: 'ch-1',
        session: SESSION,
        joinToken: 'tok-host-abc',
      });
    });

    await waitFor(() => expect(result.current.session).not.toBeNull());
    expect(result.current.session!.id).toBe('sess-001');
    expect(result.current.joinToken).toBe('tok-host-abc');
    // sent should include the start frame
    expect(sent.some((s) => s.action === 'start')).toBe(true);
  });

  it('join() emits join frame + resolves on videohangout:joined', async () => {
    const { ctx, sent, emit } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    let resolved = false;
    act(() => {
      result.current.join('sess-001').then(() => { resolved = true; });
    });

    const frame = sent.find((s) => s.action === 'join');
    expect(frame).toBeDefined();
    expect(frame!.sessionId).toBe('sess-001');

    act(() => {
      emit({
        type: 'videohangout:joined',
        channel: 'ch-1',
        session: SESSION,
        joinToken: 'tok-participant-xyz',
        participants: [PARTICIPANT_HOST, PARTICIPANT_USER],
      });
    });

    await waitFor(() => expect(resolved).toBe(true));
    expect(result.current.joinToken).toBe('tok-participant-xyz');
    expect(result.current.participants).toHaveLength(2);
  });

  it('videohangout:participant adds a new participant', async () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit({
        type: 'videohangout:joined',
        channel: 'ch-1',
        session: SESSION,
        joinToken: 'tok',
        participants: [PARTICIPANT_HOST],
      });
    });

    expect(result.current.participants).toHaveLength(1);

    act(() => {
      emit({
        type: 'videohangout:participant',
        channel: 'ch-1',
        participant: PARTICIPANT_USER,
      });
    });

    expect(result.current.participants).toHaveLength(2);
    expect(result.current.participants.find((p) => p.clientId === 'client-1')).toBeDefined();
  });

  it('videohangout:participant updates existing participant', async () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit({
        type: 'videohangout:joined',
        channel: 'ch-1',
        session: SESSION,
        joinToken: 'tok',
        participants: [PARTICIPANT_HOST],
      });
    });

    act(() => {
      emit({
        type: 'videohangout:participant',
        channel: 'ch-1',
        participant: { ...PARTICIPANT_HOST, displayName: 'Alice Updated', videoOn: false },
      });
    });

    expect(result.current.participants).toHaveLength(1);
    expect(result.current.participants[0]!.displayName).toBe('Alice Updated');
    expect(result.current.participants[0]!.videoOn).toBe(false);
  });

  it('videohangout:left removes participant', async () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit({
        type: 'videohangout:joined',
        channel: 'ch-1',
        session: SESSION,
        joinToken: 'tok',
        participants: [PARTICIPANT_HOST, PARTICIPANT_USER],
      });
    });

    act(() => {
      emit({ type: 'videohangout:left', channel: 'ch-1', clientId: 'client-host' });
    });

    expect(result.current.participants).toHaveLength(1);
    expect(result.current.participants[0]!.clientId).toBe('client-1');
  });

  it('videohangout:media updates videoOn/audioOn for correct participant', async () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit({
        type: 'videohangout:joined',
        channel: 'ch-1',
        session: SESSION,
        joinToken: 'tok',
        participants: [PARTICIPANT_HOST, PARTICIPANT_USER],
      });
    });

    act(() => {
      emit({
        type: 'videohangout:media',
        channel: 'ch-1',
        clientId: 'client-host',
        videoOn: false,
        audioOn: false,
      });
    });

    const host = result.current.participants.find((p) => p.clientId === 'client-host')!;
    expect(host.videoOn).toBe(false);
    expect(host.audioOn).toBe(false);

    // Other participant unaffected.
    const user = result.current.participants.find((p) => p.clientId === 'client-1')!;
    expect(user.videoOn).toBe(true);
    expect(user.audioOn).toBe(true);
  });

  it('leave() emits leave frame and clears session/participants', async () => {
    const { ctx, sent, emit } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit({
        type: 'videohangout:created',
        channel: 'ch-1',
        session: SESSION,
        joinToken: 'tok',
      });
    });

    await waitFor(() => expect(result.current.session).not.toBeNull());

    act(() => { void result.current.leave(); });

    const frame = sent.find((s) => s.action === 'leave');
    expect(frame).toBeDefined();
    expect(frame!.sessionId).toBe('sess-001');
    expect(result.current.session).toBeNull();
    expect(result.current.participants).toEqual([]);
    expect(result.current.joinToken).toBeNull();
  });

  it('end() emits end frame and clears state', async () => {
    const { ctx, sent, emit } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit({
        type: 'videohangout:created',
        channel: 'ch-1',
        session: SESSION,
        joinToken: 'tok',
      });
    });

    await waitFor(() => expect(result.current.session).not.toBeNull());

    act(() => { void result.current.end(); });

    const frame = sent.find((s) => s.action === 'end');
    expect(frame).toBeDefined();
    expect(frame!.sessionId).toBe('sess-001');
    expect(result.current.session).toBeNull();
  });

  it('toggleVideo() emits toggle-video frame', async () => {
    const { ctx, sent, emit } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit({ type: 'videohangout:created', channel: 'ch-1', session: SESSION, joinToken: 'tok' });
    });
    await waitFor(() => expect(result.current.session).not.toBeNull());

    act(() => { result.current.toggleVideo(); });

    const frame = sent.find((s) => s.action === 'toggle-video');
    expect(frame).toBeDefined();
    expect(frame!.sessionId).toBe('sess-001');
    expect(typeof frame!.videoOn).toBe('boolean');
  });

  it('toggleAudio() emits toggle-audio frame', async () => {
    const { ctx, sent, emit } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit({ type: 'videohangout:created', channel: 'ch-1', session: SESSION, joinToken: 'tok' });
    });
    await waitFor(() => expect(result.current.session).not.toBeNull());

    act(() => { result.current.toggleAudio(); });

    const frame = sent.find((s) => s.action === 'toggle-audio');
    expect(frame).toBeDefined();
    expect(frame!.sessionId).toBe('sess-001');
    expect(typeof frame!.audioOn).toBe('boolean');
  });

  it('videohangout:ended clears session, participants, joinToken', async () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit({
        type: 'videohangout:joined',
        channel: 'ch-1',
        session: SESSION,
        joinToken: 'tok',
        participants: [PARTICIPANT_HOST],
      });
    });

    await waitFor(() => expect(result.current.session).not.toBeNull());

    act(() => {
      emit({ type: 'videohangout:ended', channel: 'ch-1' });
    });

    expect(result.current.session).toBeNull();
    expect(result.current.participants).toEqual([]);
    expect(result.current.joinToken).toBeNull();
  });

  it('videohangout:error rejects pending start() promise', async () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    let startError: unknown;
    act(() => {
      result.current.start().catch((e) => { startError = e; });
    });

    act(() => {
      emit({ type: 'videohangout:error', channel: 'ch-1', error: 'LVS quota exceeded' } as unknown as GatewayMessage);
    });

    await waitFor(() => expect(startError).toBeDefined());
    expect((startError as Error).message).toBe('LVS quota exceeded');
  });

  it('channel change resets all state', async () => {
    const { ctx, emit } = makeGatewayContext();
    const { result, rerender } = renderHook(
      ({ ch }) => useVideoHangout(ch),
      { wrapper: makeWrapper(ctx), initialProps: { ch: 'ch-1' } },
    );

    act(() => {
      emit({
        type: 'videohangout:created',
        channel: 'ch-1',
        session: SESSION,
        joinToken: 'tok',
      });
    });

    await waitFor(() => expect(result.current.session).not.toBeNull());

    act(() => { rerender({ ch: 'ch-2' }); });

    expect(result.current.session).toBeNull();
    expect(result.current.participants).toEqual([]);
    expect(result.current.joinToken).toBeNull();
  });

  it('ignores frames for a different channel', async () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useVideoHangout('ch-1'), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emit({
        type: 'videohangout:created',
        channel: 'ch-OTHER',
        session: SESSION,
        joinToken: 'tok',
      });
    });

    expect(result.current.session).toBeNull();
  });
});
