/**
 * @jest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { GatewayContext } from '../../src/client/GatewaySocketProvider';
import type { GatewayContextValue } from '../../src/client/GatewaySocketProvider';
import type { GatewayMessage } from '../../src/client/types';
import { useChatMembers } from '../../src/client/useChatMembers';

function makeGatewayContext() {
  const handlers = new Set<(msg: GatewayMessage) => void>();
  const sent: Record<string, unknown>[] = [];
  const ctx: GatewayContextValue = {
    connectionState: 'connected', lastError: null, sessionToken: null, clientId: 'client-1', currentChannel: 'ch-1',
    switchChannel: jest.fn() as unknown as (c: string) => void,
    sendMessage: jest.fn() as unknown as (msg: Record<string, unknown>) => void,
    disconnect: jest.fn() as unknown as () => void,
    reconnect: jest.fn() as unknown as () => void,
    send: (msg: Record<string, unknown>) => { sent.push(msg); },
    subscribe: jest.fn() as unknown as (ch: string) => void,
    unsubscribe: jest.fn() as unknown as (ch: string) => void,
    publish: jest.fn() as unknown as (ch: string, frame: Record<string, unknown>) => void,
    onMessage: (handler: (msg: GatewayMessage) => void) => { handlers.add(handler); return () => handlers.delete(handler); },
  };
  const emit = (msg: GatewayMessage) => { for (const h of handlers) h(msg); };
  const wrapper = ({ children }: { children: React.ReactNode }) => <GatewayContext.Provider value={ctx}>{children}</GatewayContext.Provider>;
  return { ctx, emit, sent, wrapper };
}

describe('useChatMembers', () => {
  it('asks for the roster, takes members and membersUpdated for its channel, and sends the two changes', () => {
    const { emit, sent, wrapper } = makeGatewayContext();
    const { result } = renderHook(() => useChatMembers('room:design'), { wrapper });
    expect(sent[0]).toEqual({ service: 'chat', action: 'members', channel: 'room:design' });
    expect(result.current.loading).toBe(true);
    expect(result.current.isMember('anyone')).toBe(true); // unknown yet: assume open

    act(() => emit({ type: 'chat', action: 'members', channel: 'room:other', open: false, members: [{ userId: 'x' }] } as never));
    expect(result.current.loading).toBe(true);

    act(() => emit({ type: 'chat', action: 'members', channel: 'room:design', open: false, members: [{ userId: 'u-eve', role: 'owner', addedBy: 'u-eve', addedAt: 't', historyFrom: null }] } as never));
    expect(result.current.loading).toBe(false);
    expect(result.current.open).toBe(false);
    expect(result.current.members).toEqual([{ userId: 'u-eve', role: 'owner', addedBy: 'u-eve', addedAt: 't', historyFrom: null }]);
    expect(result.current.isMember('u-eve')).toBe(true);
    expect(result.current.isMember('u-carol')).toBe(false);

    act(() => result.current.addMembers(['u-carol'], { mode: 'days', days: 7 }, { 'u-carol': 'Carol' }));
    expect(sent.pop()).toEqual({ service: 'chat', action: 'addMembers', channel: 'room:design', userIds: ['u-carol'], history: { mode: 'days', days: 7 }, names: { 'u-carol': 'Carol' } });

    act(() => emit({ type: 'chat', action: 'membersUpdated', channel: 'room:design', open: false, members: [{ userId: 'u-eve', role: 'owner' }, { userId: 'u-carol', role: 'member', historyFrom: 't2' }] } as never));
    expect(result.current.members.map((m) => m.userId)).toEqual(['u-eve', 'u-carol']);

    act(() => result.current.removeMember('u-carol', 'Carol'));
    expect(sent.pop()).toEqual({ service: 'chat', action: 'removeMember', channel: 'room:design', userId: 'u-carol', name: 'Carol' });

    act(() => result.current.refresh());
    expect(sent.pop()).toEqual({ service: 'chat', action: 'members', channel: 'room:design' });
  });
});
