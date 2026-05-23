// realtime-modules/src/client/hangout-rooms/useRoomMembers.ts
//
// useRoomMembers(slug) — manage ACL for a private room.
//
// Responsibilities:
//   - REST `GET /api/rooms/:slug/members` on mount (and on slug change)
//   - Optional WS adapter for `room.member-joined` / `room.member-left`
//     events — when an event for this slug arrives, refetch the list
//     (the membership row may include audit fields we don't want to
//     reconstruct client-side)
//   - Imperative `addMember(userId, role)` and `removeMember(userId)`
//     with optimistic local-state updates
//   - AbortController-safe cancellation on unmount + slug change
//
// Config resolution mirrors useHangoutRooms: opts.baseUrl /
// opts.getAuthToken win, then fall back to LVSProvider context.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSafeLVSContext } from '../video/LVSProvider';
import {
  addMember as addMemberApi,
  listMembers as listMembersApi,
  removeMember as removeMemberApi,
  RoomApiError,
  type RoomApiOptions,
} from './api';
import type { RoomMember, RoomMemberRole } from './types';

/** Inbound membership event from the gateway. */
export interface RoomMemberEvent {
  type: 'room.member-joined' | 'room.member-left';
  slug: string;
  userId: string;
  /** Optional: full row when available (server may inline). */
  member?: RoomMember;
}

/** Minimal adapter shape — caller wires the gateway WS / useGateway
 *  to invoke `handler` for each membership event. Returns unsubscribe. */
export type RoomMemberEventSubscriber = (
  handler: (evt: RoomMemberEvent) => void,
) => () => void;

export interface UseRoomMembersOptions {
  /** Override base URL (else pulled from LVSProvider). */
  baseUrl?: string;
  /** Override token resolver (else pulled from LVSProvider). */
  getAuthToken?: () => string | Promise<string>;
  /** Optional WS adapter for `room.member-*` events. */
  ws?: RoomMemberEventSubscriber;
}

export interface UseRoomMembersResult {
  members: RoomMember[];
  isLoading: boolean;
  error: RoomApiError | Error | null;
  /** Add a member to the room. Optimistically appends on success. */
  addMember: (userId: string, role?: RoomMemberRole) => Promise<RoomMember>;
  /** Remove a member from the room. Optimistically drops on success. */
  removeMember: (userId: string) => Promise<void>;
  /** Force a fresh REST list. */
  refetch: () => Promise<void>;
}

/**
 * Fetch + manage members for a private room. See module docstring for
 * full behavior. Idle when `slug` is null (returns empty list,
 * isLoading=false).
 */
export function useRoomMembers(
  slug: string | null,
  opts: UseRoomMembersOptions = {},
): UseRoomMembersResult {
  const ctx = useSafeLVSContext();
  const baseUrl = opts.baseUrl ?? ctx?.baseUrl ?? '';
  const getAuthToken = opts.getAuthToken ?? ctx?.getAuthToken;

  const [members, setMembers] = useState<RoomMember[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(!!slug);
  const [error, setError] = useState<RoomApiError | Error | null>(null);

  // Stable refs so action callbacks don't churn identity per render.
  const baseUrlRef = useRef(baseUrl);
  baseUrlRef.current = baseUrl;
  const getAuthTokenRef = useRef(getAuthToken);
  getAuthTokenRef.current = getAuthToken;
  const slugRef = useRef(slug);
  slugRef.current = slug;

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const buildApiOptions = useCallback((signal?: AbortSignal): RoomApiOptions => ({
    baseUrl: baseUrlRef.current,
    getAuthToken: getAuthTokenRef.current,
    signal,
  }), []);

  const refetch = useCallback(async () => {
    const currentSlug = slugRef.current;
    if (!currentSlug) {
      setMembers([]);
      setIsLoading(false);
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setIsLoading(true);
    setError(null);
    try {
      const list = await listMembersApi(buildApiOptions(ac.signal), currentSlug);
      if (!ac.signal.aborted && mountedRef.current) {
        setMembers(list);
      }
    } catch (e: unknown) {
      if ((e as { name?: string })?.name === 'AbortError') return;
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (mountedRef.current && !ac.signal.aborted) setIsLoading(false);
    }
  }, [buildApiOptions]);

  // ---- Fetch on slug change -------------------------------------------------

  useEffect(() => {
    if (!slug) {
      setMembers([]);
      setIsLoading(false);
      setError(null);
      return;
    }
    void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, baseUrl]);

  // ---- Mount/unmount lifecycle ----------------------------------------------

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // ---- WS adapter: refetch on member-joined / member-left for this slug -----

  useEffect(() => {
    if (!opts.ws) return;
    if (!slug) return;
    const unsubscribe = opts.ws((evt) => {
      if (!mountedRef.current) return;
      if (evt.slug !== slug) return;
      // Refetch to pick up server-canonical row shape (addedAt etc.).
      void refetch();
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.ws, slug]);

  // ---- Actions --------------------------------------------------------------

  const addMember = useCallback(
    async (userId: string, role: RoomMemberRole = 'member'): Promise<RoomMember> => {
      const currentSlug = slugRef.current;
      if (!currentSlug) {
        throw new Error('useRoomMembers: cannot addMember without an active slug');
      }
      const member = await addMemberApi(buildApiOptions(), currentSlug, userId, role);
      if (mountedRef.current) {
        setMembers((prev) => {
          // Idempotent — replace existing row if userId already present.
          const idx = prev.findIndex((m) => m.userId === member.userId);
          if (idx === -1) return [...prev, member];
          const next = [...prev];
          next[idx] = member;
          return next;
        });
      }
      return member;
    },
    [buildApiOptions],
  );

  const removeMember = useCallback(
    async (userId: string): Promise<void> => {
      const currentSlug = slugRef.current;
      if (!currentSlug) {
        throw new Error('useRoomMembers: cannot removeMember without an active slug');
      }
      await removeMemberApi(buildApiOptions(), currentSlug, userId);
      if (mountedRef.current) {
        setMembers((prev) => prev.filter((m) => m.userId !== userId));
      }
    },
    [buildApiOptions],
  );

  return useMemo(
    () => ({ members, isLoading, error, addMember, removeMember, refetch }),
    [members, isLoading, error, addMember, removeMember, refetch],
  );
}
