/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useNotifications.test.tsx
//
// Exercises the useNotifications hook via a mock GatewayContext. Covers:
//   - Initial state: empty notifications + unreadCount 0
//   - notification:new arrives: state updates + unreadCount increments
//   - markAsRead: notification.read=true, unreadCount decrements
//   - markAllRead: all notifications read, unreadCount 0
//   - remove(id): removes single notification from list
//   - clearAll: empties list + resets unreadCount
//   - localStorage persistence: read-state survives simulated remount
//   - notification:read frame: server-driven read mark
//   - notification:bulk-update: merges new + updates existing
//   - Trim at maxNotifications: 101st notification drops the oldest
//   - Optional fields (body, channel, payload, action) are preserved
//   - Invalid frames (missing id/type/title/timestamp) are silently dropped

import React from 'react';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { GatewayContext } from '../../src/client/GatewaySocketProvider';
import type { GatewayContextValue } from '../../src/client/GatewaySocketProvider';
import type { GatewayMessage } from '../../src/client/types';
import { useNotifications } from '../../src/client/useNotifications';
import type { Notification } from '../../src/client/useNotifications';

// ---------------------------------------------------------------------------
// Fake GatewayContext
// ---------------------------------------------------------------------------

function makeGatewayContext() {
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
    send: jest.fn() as unknown as (msg: Record<string, unknown>) => void,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'rmn:notifications:read';

function makeNotificationPayload(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n-1',
    type: 'mention',
    title: 'You were mentioned',
    timestamp: '2026-05-22T10:00:00.000Z',
    ...overrides,
  };
}

function emitNew(emit: (msg: GatewayMessage) => void, payload: Notification) {
  emit({ type: 'notification:new', service: 'notification', payload } as unknown as GatewayMessage);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useNotifications', () => {
  it('starts with empty notifications and unreadCount 0', () => {
    const { ctx } = makeGatewayContext();
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(ctx) });

    expect(result.current.notifications).toEqual([]);
    expect(result.current.unreadCount).toBe(0);
  });

  it('notification:new adds to list and increments unreadCount', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(ctx) });

    act(() => {
      emitNew(emit, makeNotificationPayload());
    });

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0]!.id).toBe('n-1');
    expect(result.current.notifications[0]!.type).toBe('mention');
    expect(result.current.notifications[0]!.title).toBe('You were mentioned');
    expect(result.current.unreadCount).toBe(1);
  });

  it('notification:new preserves optional fields (body, channel, payload, action)', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(ctx) });

    act(() => {
      emitNew(emit, makeNotificationPayload({
        body: 'Connor mentioned you in #general',
        channel: 'general',
        payload: { messageId: 'msg-42' },
        action: { label: 'View message', href: '/channels/general/msg-42' },
      }));
    });

    const n = result.current.notifications[0]!;
    expect(n.body).toBe('Connor mentioned you in #general');
    expect(n.channel).toBe('general');
    expect(n.payload).toEqual({ messageId: 'msg-42' });
    expect(n.action).toEqual({ label: 'View message', href: '/channels/general/msg-42' });
  });

  it('markAsRead sets read=true and decrements unreadCount', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(ctx) });

    act(() => {
      emitNew(emit, makeNotificationPayload({ id: 'n-1' }));
      emitNew(emit, makeNotificationPayload({ id: 'n-2', title: 'Other' }));
    });

    expect(result.current.unreadCount).toBe(2);

    act(() => {
      result.current.markAsRead('n-1');
    });

    expect(result.current.unreadCount).toBe(1);
    expect(result.current.notifications.find((n) => n.id === 'n-1')!.read).toBe(true);
    expect(result.current.notifications.find((n) => n.id === 'n-2')!.read).toBeFalsy();
  });

  it('markAsRead is a no-op for unknown id', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(ctx) });

    act(() => {
      emitNew(emit, makeNotificationPayload({ id: 'n-1' }));
    });

    act(() => {
      result.current.markAsRead('unknown-id');
    });

    expect(result.current.unreadCount).toBe(1);
    expect(result.current.notifications).toHaveLength(1);
  });

  it('markAllRead sets all notifications as read and unreadCount to 0', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(ctx) });

    act(() => {
      emitNew(emit, makeNotificationPayload({ id: 'n-1' }));
      emitNew(emit, makeNotificationPayload({ id: 'n-2', title: 'Two' }));
      emitNew(emit, makeNotificationPayload({ id: 'n-3', title: 'Three' }));
    });

    expect(result.current.unreadCount).toBe(3);

    act(() => {
      result.current.markAllRead();
    });

    expect(result.current.unreadCount).toBe(0);
    expect(result.current.notifications.every((n) => n.read === true)).toBe(true);
  });

  it('remove(id) removes a single notification from the list', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(ctx) });

    act(() => {
      emitNew(emit, makeNotificationPayload({ id: 'n-1' }));
      emitNew(emit, makeNotificationPayload({ id: 'n-2', title: 'Two' }));
    });

    act(() => {
      result.current.remove('n-1');
    });

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0]!.id).toBe('n-2');
    expect(result.current.unreadCount).toBe(1);
  });

  it('clearAll empties the list and resets unreadCount to 0', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(ctx) });

    act(() => {
      emitNew(emit, makeNotificationPayload({ id: 'n-1' }));
      emitNew(emit, makeNotificationPayload({ id: 'n-2', title: 'Two' }));
    });

    act(() => {
      result.current.clearAll();
    });

    expect(result.current.notifications).toEqual([]);
    expect(result.current.unreadCount).toBe(0);
  });

  it('localStorage persistence: read marks survive simulated remount', () => {
    const { ctx, emit } = makeGatewayContext();

    // First mount: mark n-1 as read.
    const { result, unmount } = renderHook(() => useNotifications({ storageKey: STORAGE_KEY }), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emitNew(emit, makeNotificationPayload({ id: 'n-1' }));
    });
    act(() => {
      result.current.markAsRead('n-1');
    });

    // Verify localStorage was written.
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, boolean>;
    expect(stored['n-1']).toBe(true);

    // Unmount (simulates page navigation / component teardown).
    unmount();

    // Second mount — re-uses the same emit. Emit the same notification.
    const { result: result2 } = renderHook(() => useNotifications({ storageKey: STORAGE_KEY }), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emitNew(emit, makeNotificationPayload({ id: 'n-1' }));
    });

    // Should arrive already marked read because of persisted state.
    expect(result2.current.notifications[0]!.read).toBe(true);
    expect(result2.current.unreadCount).toBe(0);
  });

  it('clearAll removes localStorage read-state', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useNotifications({ storageKey: STORAGE_KEY }), {
      wrapper: makeWrapper(ctx),
    });

    act(() => {
      emitNew(emit, makeNotificationPayload({ id: 'n-1' }));
    });
    act(() => {
      result.current.markAsRead('n-1');
    });

    expect(localStorage.getItem(STORAGE_KEY)).toBeTruthy();

    act(() => {
      result.current.clearAll();
    });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, boolean>;
    expect(Object.keys(stored)).toHaveLength(0);
  });

  it('notification:read server frame marks the notification as read', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(ctx) });

    act(() => {
      emitNew(emit, makeNotificationPayload({ id: 'n-5' }));
    });

    expect(result.current.unreadCount).toBe(1);

    act(() => {
      emit({
        type: 'notification:read',
        service: 'notification',
        payload: { id: 'n-5' },
      } as unknown as GatewayMessage);
    });

    expect(result.current.notifications[0]!.read).toBe(true);
    expect(result.current.unreadCount).toBe(0);
  });

  it('notification:bulk-update merges new notifications into list', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(ctx) });

    // Pre-populate one notification.
    act(() => {
      emitNew(emit, makeNotificationPayload({ id: 'n-1' }));
    });

    act(() => {
      emit({
        type: 'notification:bulk-update',
        service: 'notification',
        payload: {
          notifications: [
            makeNotificationPayload({ id: 'n-2', title: 'Two', timestamp: '2026-05-22T11:00:00.000Z' }),
            makeNotificationPayload({ id: 'n-3', title: 'Three', timestamp: '2026-05-22T12:00:00.000Z' }),
          ],
        },
      } as unknown as GatewayMessage);
    });

    expect(result.current.notifications).toHaveLength(3);
    expect(result.current.unreadCount).toBe(3);
  });

  it('notification:bulk-update updates an existing notification in-place', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(ctx) });

    act(() => {
      emitNew(emit, makeNotificationPayload({ id: 'n-1', title: 'Original' }));
    });

    act(() => {
      emit({
        type: 'notification:bulk-update',
        service: 'notification',
        payload: {
          notifications: [
            makeNotificationPayload({ id: 'n-1', title: 'Updated', read: true }),
          ],
        },
      } as unknown as GatewayMessage);
    });

    // List should still have 1 item (not duplicated), with the updated title.
    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications[0]!.title).toBe('Updated');
    expect(result.current.notifications[0]!.read).toBe(true);
    expect(result.current.unreadCount).toBe(0);
  });

  it('trim: 101st notification drops the oldest', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(
      () => useNotifications({ maxNotifications: 100 }),
      { wrapper: makeWrapper(ctx) },
    );

    // Emit 101 notifications.
    act(() => {
      for (let i = 1; i <= 101; i++) {
        emitNew(emit, makeNotificationPayload({
          id: `n-${i}`,
          title: `Notification ${i}`,
          timestamp: new Date(Date.UTC(2026, 4, 22, 0, i)).toISOString(),
        }));
      }
    });

    expect(result.current.notifications).toHaveLength(100);
    // The oldest (n-1) should be gone; n-101 should be present.
    expect(result.current.notifications.find((n) => n.id === 'n-1')).toBeUndefined();
    expect(result.current.notifications[result.current.notifications.length - 1]!.id).toBe('n-101');
  });

  it('trim: custom maxNotifications is respected', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(
      () => useNotifications({ maxNotifications: 3 }),
      { wrapper: makeWrapper(ctx) },
    );

    act(() => {
      for (let i = 1; i <= 5; i++) {
        emitNew(emit, makeNotificationPayload({ id: `n-${i}`, title: `Notif ${i}` }));
      }
    });

    expect(result.current.notifications).toHaveLength(3);
    // Oldest two (n-1, n-2) dropped.
    expect(result.current.notifications[0]!.id).toBe('n-3');
    expect(result.current.notifications[2]!.id).toBe('n-5');
  });

  it('silently ignores notification:new frames with missing required fields', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(ctx) });

    act(() => {
      // Missing id.
      emit({ type: 'notification:new', service: 'notification', payload: { type: 'mention', title: 'Hi', timestamp: '2026-05-22T10:00:00Z' } } as unknown as GatewayMessage);
      // Missing title.
      emit({ type: 'notification:new', service: 'notification', payload: { id: 'x', type: 'mention', timestamp: '2026-05-22T10:00:00Z' } } as unknown as GatewayMessage);
      // Missing timestamp.
      emit({ type: 'notification:new', service: 'notification', payload: { id: 'x', type: 'mention', title: 'Hi' } } as unknown as GatewayMessage);
      // Null payload.
      emit({ type: 'notification:new', service: 'notification', payload: null } as unknown as GatewayMessage);
    });

    expect(result.current.notifications).toHaveLength(0);
    expect(result.current.unreadCount).toBe(0);
  });

  it('multiple notification types are all accepted', () => {
    const { ctx, emit } = makeGatewayContext();
    const { result } = renderHook(() => useNotifications(), { wrapper: makeWrapper(ctx) });

    const types = ['mention', 'reply', 'approval-requested', 'approval-resolved', 'file-scan', 'system'] as const;

    act(() => {
      types.forEach((type, i) => {
        emitNew(emit, makeNotificationPayload({ id: `n-${i}`, type }));
      });
    });

    expect(result.current.notifications).toHaveLength(types.length);
    types.forEach((type, i) => {
      expect(result.current.notifications[i]!.type).toBe(type);
    });
  });
});
