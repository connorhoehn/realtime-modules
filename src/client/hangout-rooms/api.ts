// realtime-modules/src/client/hangout-rooms/api.ts
//
// Pure REST client for the persistent-rooms feature. Framework-free —
// no React, no DOM. Hooks (useHangoutRooms, useRoomOccupancy,
// useRoomMembers) compose these functions; consumers can also call them
// directly for one-off operations (server-side rendering, scripts).
//
// Config shape mirrors LVSProvider's: `{ baseUrl, getAuthToken }`. The
// token resolver is awaited per-call so consumers can rotate tokens
// without restarting the hook tree.
//
// All endpoints are scoped under `/api/rooms` on the platform-api side.
// Errors are normalized to `RoomApiError` so callers can branch on
// `status` (HTTP) + `code` (server-side error code string) without
// parsing message strings.

import type {
  CreateRoomInput,
  JoinRoomResult,
  ListRoomsQuery,
  Room,
  RoomMember,
  RoomMemberRole,
  UpdateRoomInput,
} from './types';

/** Normalized error for all room API failures. Callers can branch on
 *  `status` (HTTP) or `code` (server error code) without string-matching
 *  the message. */
export class RoomApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'RoomApiError';
    this.status = status;
    this.code = code;
  }
}

/** Per-call configuration. Same shape used by the hooks, so the hooks
 *  can pass straight through after resolving `baseUrl` + `getAuthToken`
 *  from the LVSProvider context. */
export interface RoomApiOptions {
  /** Base URL of the platform-api. URLs are derived as
   *  `${baseUrl}/api/rooms[/...]`. Defaults to same-origin (''). */
  baseUrl?: string;
  /** Lazy bearer-token resolver. Called once per request. May return
   *  a Promise. Returning empty string means "no Authorization header". */
  getAuthToken?: () => string | Promise<string>;
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function resolveHeaders(
  opts: RoomApiOptions,
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (opts.getAuthToken) {
    const token = await opts.getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function parseErrorBody(res: Response): Promise<{ code: string; message: string }> {
  // The platform-api error shape is `{ error: { code, message } }`. Fall
  // back to plain text + a generic code so we still produce a useful
  // error when the server returns HTML / proxy errors / empty bodies.
  try {
    const data = (await res.json()) as { error?: { code?: string; message?: string } };
    return {
      code: data?.error?.code ?? `HTTP_${res.status}`,
      message: data?.error?.message ?? res.statusText ?? `HTTP ${res.status}`,
    };
  } catch {
    return { code: `HTTP_${res.status}`, message: res.statusText || `HTTP ${res.status}` };
  }
}

async function request<T>(
  opts: RoomApiOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const baseUrl = opts.baseUrl ?? '';
  const headers = await resolveHeaders(
    opts,
    body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
  );
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts.signal,
  });
  if (!res.ok) {
    const { code, message } = await parseErrorBody(res);
    throw new RoomApiError(message, res.status, code);
  }
  // 204 No Content — return undefined cast to T (callers typed as void).
  if (res.status === 204) return undefined as T;
  // Some endpoints (DELETE) may return empty 200 — guard the JSON parse.
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function buildQueryString(query?: ListRoomsQuery): string {
  if (!query) return '';
  const params = new URLSearchParams();
  if (query.state) params.set('state', query.state);
  if (query.visibility) params.set('visibility', query.visibility);
  if (query.cursor) params.set('cursor', query.cursor);
  if (typeof query.limit === 'number') params.set('limit', String(query.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// ---------------------------------------------------------------------------
// Room operations
// ---------------------------------------------------------------------------

/**
 * List rooms visible to the caller, optionally filtered.
 * `GET /api/rooms[?state=…&visibility=…&cursor=…&limit=…]`
 *
 * Server returns either a bare `Room[]` or `{ rooms: Room[] }` — both
 * shapes are accepted. Returns `[]` when the server returns nothing.
 */
export async function listRooms(
  opts: RoomApiOptions,
  query?: ListRoomsQuery,
): Promise<Room[]> {
  const data = await request<Room[] | { rooms?: Room[] }>(
    opts,
    'GET',
    `/api/rooms${buildQueryString(query)}`,
  );
  if (Array.isArray(data)) return data;
  return data?.rooms ?? [];
}

/** Get a single room by slug. `GET /api/rooms/:slug`. */
export async function getRoom(opts: RoomApiOptions, slug: string): Promise<Room> {
  return request<Room>(opts, 'GET', `/api/rooms/${encodeURIComponent(slug)}`);
}

/** Create a new room. `POST /api/rooms`. */
export async function createRoom(
  opts: RoomApiOptions,
  input: CreateRoomInput,
): Promise<Room> {
  return request<Room>(opts, 'POST', `/api/rooms`, input);
}

/** Update mutable fields on an existing room. `PATCH /api/rooms/:slug`. */
export async function updateRoom(
  opts: RoomApiOptions,
  slug: string,
  patch: UpdateRoomInput,
): Promise<Room> {
  return request<Room>(opts, 'PATCH', `/api/rooms/${encodeURIComponent(slug)}`, patch);
}

/** Archive a room (soft-delete). `DELETE /api/rooms/:slug`. */
export async function archiveRoom(opts: RoomApiOptions, slug: string): Promise<void> {
  await request<void>(opts, 'DELETE', `/api/rooms/${encodeURIComponent(slug)}`);
}

/**
 * Join a room — provisions an SFU session and returns the participant
 * token + id ready to hand to <Stage> or useLVSHangout.
 * `POST /api/rooms/:slug/join`.
 */
export async function joinRoom(
  opts: RoomApiOptions,
  slug: string,
): Promise<JoinRoomResult> {
  return request<JoinRoomResult>(opts, 'POST', `/api/rooms/${encodeURIComponent(slug)}/join`);
}

/** Leave a room — releases the SFU session.
 *  `POST /api/rooms/:slug/leave`. */
export async function leaveRoom(opts: RoomApiOptions, slug: string): Promise<void> {
  await request<void>(opts, 'POST', `/api/rooms/${encodeURIComponent(slug)}/leave`);
}

// ---------------------------------------------------------------------------
// Membership operations (private rooms)
// ---------------------------------------------------------------------------

/** List ACL members for a private room.
 *  `GET /api/rooms/:slug/members`. */
export async function listMembers(
  opts: RoomApiOptions,
  slug: string,
): Promise<RoomMember[]> {
  const data = await request<RoomMember[] | { members?: RoomMember[] }>(
    opts,
    'GET',
    `/api/rooms/${encodeURIComponent(slug)}/members`,
  );
  if (Array.isArray(data)) return data;
  return data?.members ?? [];
}

/** Add a member to a private room.
 *  `POST /api/rooms/:slug/members`. */
export async function addMember(
  opts: RoomApiOptions,
  slug: string,
  userId: string,
  role: RoomMemberRole = 'member',
): Promise<RoomMember> {
  return request<RoomMember>(opts, 'POST', `/api/rooms/${encodeURIComponent(slug)}/members`, {
    userId,
    role,
  });
}

/** Remove a member from a private room.
 *  `DELETE /api/rooms/:slug/members/:userId`. */
export async function removeMember(
  opts: RoomApiOptions,
  slug: string,
  userId: string,
): Promise<void> {
  await request<void>(
    opts,
    'DELETE',
    `/api/rooms/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}`,
  );
}
