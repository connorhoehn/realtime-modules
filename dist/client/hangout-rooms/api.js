"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoomApiError = void 0;
exports.listRooms = listRooms;
exports.getRoom = getRoom;
exports.createRoom = createRoom;
exports.updateRoom = updateRoom;
exports.archiveRoom = archiveRoom;
exports.joinRoom = joinRoom;
exports.leaveRoom = leaveRoom;
exports.listMembers = listMembers;
exports.addMember = addMember;
exports.removeMember = removeMember;
/** Normalized error for all room API failures. Callers can branch on
 *  `status` (HTTP) or `code` (server error code) without string-matching
 *  the message. */
class RoomApiError extends Error {
    status;
    code;
    constructor(message, status, code) {
        super(message);
        this.name = 'RoomApiError';
        this.status = status;
        this.code = code;
    }
}
exports.RoomApiError = RoomApiError;
// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
async function resolveHeaders(opts, extra) {
    const headers = { ...(extra ?? {}) };
    if (opts.getAuthToken) {
        const token = await opts.getAuthToken();
        if (token)
            headers.Authorization = `Bearer ${token}`;
    }
    return headers;
}
async function parseErrorBody(res) {
    // The platform-api error shape is `{ error: { code, message } }`. Fall
    // back to plain text + a generic code so we still produce a useful
    // error when the server returns HTML / proxy errors / empty bodies.
    try {
        const data = (await res.json());
        return {
            code: data?.error?.code ?? `HTTP_${res.status}`,
            message: data?.error?.message ?? res.statusText ?? `HTTP ${res.status}`,
        };
    }
    catch {
        return { code: `HTTP_${res.status}`, message: res.statusText || `HTTP ${res.status}` };
    }
}
async function request(opts, method, path, body) {
    const baseUrl = opts.baseUrl ?? '';
    const headers = await resolveHeaders(opts, body !== undefined ? { 'Content-Type': 'application/json' } : undefined);
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
    if (res.status === 204)
        return undefined;
    // Some endpoints (DELETE) may return empty 200 — guard the JSON parse.
    const text = await res.text();
    if (!text)
        return undefined;
    return JSON.parse(text);
}
function buildQueryString(query) {
    if (!query)
        return '';
    const params = new URLSearchParams();
    if (query.state)
        params.set('state', query.state);
    if (query.visibility)
        params.set('visibility', query.visibility);
    if (query.cursor)
        params.set('cursor', query.cursor);
    if (typeof query.limit === 'number')
        params.set('limit', String(query.limit));
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
async function listRooms(opts, query) {
    const data = await request(opts, 'GET', `/api/rooms${buildQueryString(query)}`);
    if (Array.isArray(data))
        return data;
    return data?.rooms ?? [];
}
/** Get a single room by slug. `GET /api/rooms/:slug`. */
async function getRoom(opts, slug) {
    return request(opts, 'GET', `/api/rooms/${encodeURIComponent(slug)}`);
}
/** Create a new room. `POST /api/rooms`. */
async function createRoom(opts, input) {
    return request(opts, 'POST', `/api/rooms`, input);
}
/** Update mutable fields on an existing room. `PATCH /api/rooms/:slug`. */
async function updateRoom(opts, slug, patch) {
    return request(opts, 'PATCH', `/api/rooms/${encodeURIComponent(slug)}`, patch);
}
/** Archive a room (soft-delete). `DELETE /api/rooms/:slug`. */
async function archiveRoom(opts, slug) {
    await request(opts, 'DELETE', `/api/rooms/${encodeURIComponent(slug)}`);
}
/**
 * Join a room — provisions an SFU session and returns the participant
 * token + id ready to hand to <Stage> or useLVSHangout.
 * `POST /api/rooms/:slug/join`.
 */
async function joinRoom(opts, slug) {
    return request(opts, 'POST', `/api/rooms/${encodeURIComponent(slug)}/join`);
}
/** Leave a room — releases the SFU session.
 *  `POST /api/rooms/:slug/leave`. */
async function leaveRoom(opts, slug) {
    await request(opts, 'POST', `/api/rooms/${encodeURIComponent(slug)}/leave`);
}
// ---------------------------------------------------------------------------
// Membership operations (private rooms)
// ---------------------------------------------------------------------------
/** List ACL members for a private room.
 *  `GET /api/rooms/:slug/members`. */
async function listMembers(opts, slug) {
    const data = await request(opts, 'GET', `/api/rooms/${encodeURIComponent(slug)}/members`);
    if (Array.isArray(data))
        return data;
    return data?.members ?? [];
}
/** Add a member to a private room.
 *  `POST /api/rooms/:slug/members`. */
async function addMember(opts, slug, userId, role = 'member') {
    return request(opts, 'POST', `/api/rooms/${encodeURIComponent(slug)}/members`, {
        userId,
        role,
    });
}
/** Remove a member from a private room.
 *  `DELETE /api/rooms/:slug/members/:userId`. */
async function removeMember(opts, slug, userId) {
    await request(opts, 'DELETE', `/api/rooms/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}`);
}
//# sourceMappingURL=api.js.map