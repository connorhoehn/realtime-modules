// realtime-modules/src/client/hangout-rooms/useHangoutRooms.ts
//
// useHangoutRooms — list + manage persistent rooms.
//
// Responsibilities:
//   - REST list (filtered to active by default) on mount
//   - Optional WS adapter for live `room.created` / `room.updated` /
//     `room.archived` events so the list stays fresh without polling
//   - Imperative `createRoom`, `archiveRoom`, `joinRoom` actions
//   - AbortController-safe: in-flight fetches are cancelled on unmount
//     and on dep changes
//
// Config resolution mirrors useLVSHangout / useLVSRecordings:
//   1. opts.baseUrl ?? LVSProvider.baseUrl ?? ''
//   2. opts.getAuthToken ?? LVSProvider.getAuthToken (required for auth)
//
// The optional `ws` adapter is intentionally minimal — a
// `subscribe(handler): () => void` shape — so apps can plug in their
// gateway WebSocket (useGateway, raw ws, etc.) without this hook
// depending on a specific WS API.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSafeLVSContext } from '../video/LVSProvider';
import {
  archiveRoom as archiveRoomApi,
  createRoom as createRoomApi,
  joinRoom as joinRoomApi,
  listRooms as listRoomsApi,
  RoomApiError,
  type RoomApiOptions,
} from './api';
import type {
  CreateRoomInput,
  JoinRoomResult,
  ListRoomsQuery,
  Room,
} from './types';

/** Inbound room lifecycle event from the gateway. */
export interface RoomEvent {
  type: 'room.created' | 'room.updated' | 'room.archived';
  room?: Room;
  /** For `room.archived`: only the slug is guaranteed. */
  slug?: string;
}

/** Minimal WS adapter shape — caller wires the gateway WS / useGateway
 *  / raw EventSource to this. Returns an unsubscribe fn. */
export type RoomEventSubscriber = (handler: (evt: RoomEvent) => void) => () => void;

export interface UseHangoutRoomsOptions {
  /** Override base URL (else pulled from LVSProvider). */
  baseUrl?: string;
  /** Override token resolver (else pulled from LVSProvider). */
  getAuthToken?: () => string | Promise<string>;
  /** Auto-fetch on mount. Default true. */
  autoFetch?: boolean;
  /** Filter applied to the initial REST list. Default `{ state: 'active' }`. */
  query?: ListRoomsQuery;
  /** Optional WS adapter to receive `room.*` events. When provided, the
   *  list is patched in-place as events arrive. */
  ws?: RoomEventSubscriber;
}

export interface UseHangoutRoomsResult {
  rooms: Room[];
  isLoading: boolean;
  error: RoomApiError | Error | null;
  /** Force a fresh REST list. */
  refetch: () => Promise<void>;
  /** Create a new room. Adds it to local state on success (idempotent
   *  with the WS `room.created` echo). */
  createRoom: (input: CreateRoomInput) => Promise<Room>;
  /** Archive a room. Removes it from local state on success. */
  archiveRoom: (slug: string) => Promise<void>;
  /** Join a room — returns the SFU session details ready for <Stage> /
   *  useLVSHangout. */
  joinRoom: (slug: string) => Promise<JoinRoomResult>;
}

/**
 * List + manage persistent hangout rooms. See module docstring for
 * full behavior. Cancellation-safe; abort fetch on unmount.
 *
 * Example:
 * ```tsx
 * const { rooms, createRoom, joinRoom } = useHangoutRooms({
 *   ws: (handler) => subscribeRoomsIndex(handler),
 * });
 * ```
 */
export function useHangoutRooms(opts: UseHangoutRoomsOptions = {}): UseHangoutRoomsResult {
  const ctx = useSafeLVSContext();
  const baseUrl = opts.baseUrl ?? ctx?.baseUrl ?? '';
  const getAuthToken = opts.getAuthToken ?? ctx?.getAuthToken;
  const autoFetch = opts.autoFetch ?? true;

  const [rooms, setRooms] = useState<Room[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(autoFetch);
  const [error, setError] = useState<RoomApiError | Error | null>(null);

  // Stable refs so refetch / actions don't churn their identity each
  // render (callers may pass them to memoized children).
  const baseUrlRef = useRef(baseUrl);
  baseUrlRef.current = baseUrl;
  const getAuthTokenRef = useRef(getAuthToken);
  getAuthTokenRef.current = getAuthToken;
  const queryRef = useRef<ListRoomsQuery | undefined>(opts.query);
  queryRef.current = opts.query;

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const buildApiOptions = useCallback((signal?: AbortSignal): RoomApiOptions => ({
    baseUrl: baseUrlRef.current,
    getAuthToken: getAuthTokenRef.current,
    signal,
  }), []);

  const refetch = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setIsLoading(true);
    setError(null);
    try {
      const list = await listRoomsApi(
        buildApiOptions(ac.signal),
        queryRef.current ?? { state: 'active' },
      );
      if (!ac.signal.aborted && mountedRef.current) {
        setRooms(list);
      }
    } catch (e: unknown) {
      // AbortError is the only error we silently swallow — caller-cancelled.
      if ((e as { name?: string })?.name === 'AbortError') return;
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (mountedRef.current && !ac.signal.aborted) setIsLoading(false);
    }
  }, [buildApiOptions]);

  // ---- Auto-fetch on mount + dep changes ------------------------------------

  useEffect(() => {
    if (!autoFetch) {
      setIsLoading(false);
      return;
    }
    void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFetch, baseUrl]);

  // ---- Mount/unmount lifecycle ----------------------------------------------

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // ---- WS adapter — merge live events into local state ----------------------

  useEffect(() => {
    if (!opts.ws) return;
    const unsubscribe = opts.ws((evt) => {
      if (!mountedRef.current) return;
      switch (evt.type) {
        case 'room.created': {
          if (!evt.room) return;
          const room = evt.room;
          setRooms((prev) => {
            // Dedup by slug — if create echo arrives after our local
            // createRoom optimistic add, just replace in-place.
            const idx = prev.findIndex((r) => r.slug === room.slug);
            if (idx === -1) return [...prev, room];
            const next = [...prev];
            next[idx] = room;
            return next;
          });
          break;
        }
        case 'room.updated': {
          if (!evt.room) return;
          const room = evt.room;
          setRooms((prev) => {
            const idx = prev.findIndex((r) => r.slug === room.slug);
            if (idx === -1) return prev;
            const next = [...prev];
            next[idx] = room;
            return next;
          });
          break;
        }
        case 'room.archived': {
          const slug = evt.slug ?? evt.room?.slug;
          if (!slug) return;
          setRooms((prev) => prev.filter((r) => r.slug !== slug));
          break;
        }
        default:
          break;
      }
    });
    return unsubscribe;
  }, [opts.ws]);

  // ---- Actions --------------------------------------------------------------

  const createRoom = useCallback(
    async (input: CreateRoomInput): Promise<Room> => {
      const room = await createRoomApi(buildApiOptions(), input);
      if (mountedRef.current) {
        setRooms((prev) => {
          // Idempotent w.r.t. WS echo: dedup by slug.
          if (prev.some((r) => r.slug === room.slug)) return prev;
          return [...prev, room];
        });
      }
      return room;
    },
    [buildApiOptions],
  );

  const archiveRoom = useCallback(
    async (slug: string): Promise<void> => {
      await archiveRoomApi(buildApiOptions(), slug);
      if (mountedRef.current) {
        setRooms((prev) => prev.filter((r) => r.slug !== slug));
      }
    },
    [buildApiOptions],
  );

  const joinRoom = useCallback(
    async (slug: string): Promise<JoinRoomResult> => {
      return joinRoomApi(buildApiOptions(), slug);
    },
    [buildApiOptions],
  );

  return useMemo(
    () => ({ rooms, isLoading, error, refetch, createRoom, archiveRoom, joinRoom }),
    [rooms, isLoading, error, refetch, createRoom, archiveRoom, joinRoom],
  );
}
