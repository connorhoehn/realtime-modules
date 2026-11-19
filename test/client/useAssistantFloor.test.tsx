/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useAssistantFloor.test.tsx
import { describe, it, expect } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useAssistantFloor, parseAssistantFloor, assistantFloorFrame, floorFromFrame, NO_ASSISTANT_FLOOR,
} from '../../src/client/useAssistantFloor';

const CH = 'orgiq:huddle:call-1';
const HUGO = { userId: 'u-hugo', name: 'Hugo', via: 'hold', phase: 'routing' } as const;

function fakeGateway(state = 'connected') {
  const handlers = new Set<(f: unknown) => void>();
  return {
    connectionState: state,
    onMessage: (h: (f: unknown) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
    emit: (f: unknown) => { for (const h of handlers) h(f); },
    count: () => handlers.size,
  };
}

describe('parseAssistantFloor', () => {
  it('keeps a well-formed floor and mayHold', () => {
    expect(parseAssistantFloor({ handsfree: true, floor: HUGO, mayHold: true })).toEqual({ handsfree: true, floor: HUGO, mayHold: true });
  });
  it('drops the floor while not hands-free and anything malformed', () => {
    expect(parseAssistantFloor({ handsfree: false, floor: HUGO })).toEqual({ handsfree: false, floor: null });
    expect(parseAssistantFloor({ handsfree: true, floor: { ...HUGO, via: 'shout' } })).toEqual({ handsfree: true, floor: null });
    expect(parseAssistantFloor(null)).toEqual(NO_ASSISTANT_FLOOR);
  });
  it('round-trips the server frame and ignores other channels', () => {
    const frame = assistantFloorFrame(CH, { handsfree: true, floor: HUGO });
    expect(floorFromFrame(frame, CH)).toEqual({ handsfree: true, floor: HUGO });
    expect(floorFromFrame(frame, 'orgiq:huddle:other')).toBeNull();
    expect(floorFromFrame({ type: 'assistant-audio', channel: CH }, CH)).toBeNull();
  });
});

describe('useAssistantFloor', () => {
  it('reads once, then applies frames without reading again', async () => {
    const gw = fakeGateway();
    let reads = 0;
    const read = async () => { reads += 1; return { handsfree: true, floor: null, mayHold: true }; };
    const { result } = renderHook(() => useAssistantFloor({ channel: CH, read, gateway: gw }));
    await waitFor(() => expect(result.current.view).toEqual({ handsfree: true, floor: null, mayHold: true }));
    act(() => gw.emit(assistantFloorFrame(CH, { handsfree: true, floor: HUGO })));
    expect(result.current.view).toEqual({ handsfree: true, floor: HUGO, mayHold: true });
    act(() => gw.emit(assistantFloorFrame(CH, { handsfree: true, floor: null })));
    expect(result.current.view.floor).toBeNull();
    expect(reads).toBe(1);
  });

  it('reads again after a reconnect', async () => {
    let gw = fakeGateway('connected');
    let reads = 0;
    const read = async () => { reads += 1; return { handsfree: true, floor: null }; };
    const { rerender } = renderHook(({ g }) => useAssistantFloor({ channel: CH, read, gateway: g }), { initialProps: { g: gw } });
    await waitFor(() => expect(reads).toBe(1));
    gw = { ...gw, connectionState: 'reconnecting' }; rerender({ g: gw });
    gw = { ...gw, connectionState: 'connected' }; rerender({ g: gw });
    await waitFor(() => expect(reads).toBe(2));
  });

  it('does nothing without a channel or when disabled', () => {
    const gw = fakeGateway();
    const { result } = renderHook(() => useAssistantFloor({ channel: null, gateway: gw }));
    expect(result.current.view).toEqual(NO_ASSISTANT_FLOOR);
    expect(gw.count()).toBe(0);
  });

  it('apply takes a hold answer and keeps mayHold', async () => {
    const gw = fakeGateway();
    const { result } = renderHook(() => useAssistantFloor({ channel: CH, read: async () => ({ handsfree: true, floor: null, mayHold: true }), gateway: gw }));
    await waitFor(() => expect(result.current.view.mayHold).toBe(true));
    act(() => result.current.apply({ holding: true, handsfree: true, floor: HUGO }));
    expect(result.current.view).toEqual({ handsfree: true, floor: HUGO, mayHold: true });
  });
});
