/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useHangoutRooms.test.tsx
//
// Exercises useHangoutRooms via a stubbed global.fetch + an in-memory
// WS adapter. Covers:
//   - Basic list flow: REST resolves → rooms populated, isLoading false
//   - Auth header forwarded from getAuthToken
//   - Filtered to state=active by default
//   - createRoom flow: POST issued + local state updated optimistically
//   - WS room.created event merges into list (dedup vs optimistic)
//   - WS room.archived removes from list
//   - REST error is surfaced as RoomApiError
//   - autoFetch=false skips initial REST call

import React from 'react';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useHangoutRooms,
  type RoomEvent,
  type RoomEventSubscriber,
} from '../../src/client/hangout-rooms/useHangoutRooms';
import { RoomApiError } from '../../src/client/hangout-rooms/api';
import type { Room } from '../../src/client/hangout-rooms/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    orgId: 'org-1',
    roomId: 'r-1',
    slug: 'general',
    name: 'General',
    description: undefined,
    createdBy: 'u-1',
    createdAt: '2026-05-23T00:00:00Z',
    visibility: 'org',
    settings: { audioOnly: false, recordingEnabled: false, softCap: 25 },
    state: 'active',
    lastActiveAt: '2026-05-23T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fetch stub
// ---------------------------------------------------------------------------

interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface StubResponse {
  status: number;
  body: unknown;
}

function installFetchStub() {
  const calls: StubCall[] = [];
  const responses = new Map<string, StubResponse>();
  // Default-handler functions keyed by `${method} ${pathPrefix}`. Used when
  // no exact match is set in `responses`.
  const handlers = new Map<string, (call: StubCall) => StubResponse>();

  const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    const body = typeof init?.body === 'string' ? init.body : null;
    const call: StubCall = { url, method, headers, body };
    calls.push(call);

    const exactKey = `${method} ${url}`;
    const exact = responses.get(exactKey);
    if (exact) {
      return makeResponse(exact);
    }

    for (const [key, handler] of handlers.entries()) {
      const [hMethod, hPrefix] = key.split(' ', 2);
      if (hMethod === method && url.startsWith(hPrefix ?? '')) {
        return makeResponse(handler(call));
      }
    }

    return makeResponse({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'not found' } } });
  });

  function makeResponse({ status, body }: StubResponse): Response {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const res = {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : `Status ${status}`,
      async json() { return body; },
      async text() { return text; },
    } as unknown as Response;
    return res;
  }

  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;

  return {
    calls,
    setResponse(method: string, url: string, response: StubResponse) {
      responses.set(`${method.toUpperCase()} ${url}`, response);
    },
    setHandler(method: string, urlPrefix: string, handler: (call: StubCall) => StubResponse) {
      handlers.set(`${method.toUpperCase()} ${urlPrefix}`, handler);
    },
    reset() {
      calls.length = 0;
      responses.clear();
      handlers.clear();
      fetchImpl.mockClear();
    },
  };
}

// ---------------------------------------------------------------------------
// WS adapter helper
// ---------------------------------------------------------------------------

function makeWsAdapter(): { subscribe: RoomEventSubscriber; emit: (evt: RoomEvent) => void } {
  const handlers = new Set<(evt: RoomEvent) => void>();
  const subscribe: RoomEventSubscriber = (handler) => {
    handlers.add(handler);
    return () => handlers.delete(handler);
  };
  const emit = (evt: RoomEvent) => {
    for (const h of handlers) h(evt);
  };
  return { subscribe, emit };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let fetchStub: ReturnType<typeof installFetchStub>;

beforeEach(() => {
  fetchStub = installFetchStub();
});

afterEach(() => {
  jest.clearAllMocks();
  fetchStub.reset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useHangoutRooms', () => {
  it('REST list populates rooms + clears isLoading', async () => {
    const room = makeRoom({ slug: 'general' });
    fetchStub.setHandler('GET', 'http://api/api/rooms', () => ({
      status: 200,
      body: [room],
    }));

    const { result } = renderHook(() =>
      useHangoutRooms({
        baseUrl: 'http://api',
        getAuthToken: () => 'token-123',
      }),
    );

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.rooms).toHaveLength(1);
    expect(result.current.rooms[0].slug).toBe('general');
    expect(result.current.error).toBeNull();
  });

  it('forwards Authorization header from getAuthToken', async () => {
    fetchStub.setHandler('GET', 'http://api/api/rooms', () => ({
      status: 200,
      body: [],
    }));

    renderHook(() =>
      useHangoutRooms({
        baseUrl: 'http://api',
        getAuthToken: () => 'tok-abc',
      }),
    );

    await waitFor(() => expect(fetchStub.calls.length).toBeGreaterThan(0));
    const listCall = fetchStub.calls.find((c) => c.method === 'GET');
    expect(listCall?.headers.Authorization).toBe('Bearer tok-abc');
  });

  it('filters by state=active by default', async () => {
    fetchStub.setHandler('GET', 'http://api/api/rooms', () => ({
      status: 200,
      body: [],
    }));

    renderHook(() =>
      useHangoutRooms({
        baseUrl: 'http://api',
        getAuthToken: () => '',
      }),
    );

    await waitFor(() => expect(fetchStub.calls.length).toBeGreaterThan(0));
    const url = fetchStub.calls[0]?.url ?? '';
    expect(url).toContain('state=active');
  });

  it('createRoom POSTs and appends to local state', async () => {
    const existing = makeRoom({ slug: 'general' });
    const created = makeRoom({ slug: 'new-room', roomId: 'r-2', name: 'New Room' });
    fetchStub.setHandler('GET', 'http://api/api/rooms', () => ({
      status: 200,
      body: [existing],
    }));
    fetchStub.setResponse('POST', 'http://api/api/rooms', {
      status: 200,
      body: created,
    });

    const { result } = renderHook(() =>
      useHangoutRooms({
        baseUrl: 'http://api',
        getAuthToken: () => 't',
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rooms).toHaveLength(1);

    let returned: Room | null = null;
    await act(async () => {
      returned = await result.current.createRoom({ name: 'New Room' });
    });

    expect(returned).not.toBeNull();
    expect(returned!.slug).toBe('new-room');
    expect(result.current.rooms).toHaveLength(2);
    expect(result.current.rooms.map((r) => r.slug)).toContain('new-room');

    // Body was forwarded as JSON.
    const postCall = fetchStub.calls.find((c) => c.method === 'POST');
    expect(postCall?.body).toBe(JSON.stringify({ name: 'New Room' }));
    expect(postCall?.headers['Content-Type']).toBe('application/json');
  });

  it('WS room.created merges into list (dedup vs optimistic create)', async () => {
    const ws = makeWsAdapter();
    fetchStub.setHandler('GET', 'http://api/api/rooms', () => ({
      status: 200,
      body: [],
    }));

    const { result } = renderHook(() =>
      useHangoutRooms({
        baseUrl: 'http://api',
        getAuthToken: () => '',
        ws: ws.subscribe,
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const newRoom = makeRoom({ slug: 'live-room', roomId: 'r-9' });
    act(() => ws.emit({ type: 'room.created', room: newRoom }));
    expect(result.current.rooms).toHaveLength(1);
    expect(result.current.rooms[0].slug).toBe('live-room');

    // Second emit with the same slug should replace, not duplicate.
    const updated = { ...newRoom, name: 'Renamed' };
    act(() => ws.emit({ type: 'room.created', room: updated }));
    expect(result.current.rooms).toHaveLength(1);
    expect(result.current.rooms[0].name).toBe('Renamed');
  });

  it('WS room.archived removes from list', async () => {
    const ws = makeWsAdapter();
    const room = makeRoom({ slug: 'doomed' });
    fetchStub.setHandler('GET', 'http://api/api/rooms', () => ({
      status: 200,
      body: [room],
    }));

    const { result } = renderHook(() =>
      useHangoutRooms({
        baseUrl: 'http://api',
        getAuthToken: () => '',
        ws: ws.subscribe,
      }),
    );

    await waitFor(() => expect(result.current.rooms).toHaveLength(1));

    act(() => ws.emit({ type: 'room.archived', slug: 'doomed' }));
    expect(result.current.rooms).toHaveLength(0);
  });

  it('REST 500 surfaces as RoomApiError', async () => {
    fetchStub.setHandler('GET', 'http://api/api/rooms', () => ({
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'server boom' } },
    }));

    const { result } = renderHook(() =>
      useHangoutRooms({
        baseUrl: 'http://api',
        getAuthToken: () => '',
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBeInstanceOf(RoomApiError);
    expect((result.current.error as RoomApiError).status).toBe(500);
    expect((result.current.error as RoomApiError).code).toBe('INTERNAL');
    expect(result.current.rooms).toEqual([]);
  });

  it('autoFetch=false skips initial REST call', async () => {
    const { result } = renderHook(() =>
      useHangoutRooms({
        baseUrl: 'http://api',
        getAuthToken: () => '',
        autoFetch: false,
      }),
    );

    // No fetch should have been issued.
    expect(fetchStub.calls).toHaveLength(0);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.rooms).toEqual([]);

    // Manual refetch still works.
    fetchStub.setHandler('GET', 'http://api/api/rooms', () => ({
      status: 200,
      body: [makeRoom({ slug: 'lazy' })],
    }));
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.rooms).toHaveLength(1);
    expect(result.current.rooms[0].slug).toBe('lazy');
  });
});
