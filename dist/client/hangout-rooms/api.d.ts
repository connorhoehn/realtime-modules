import type { CreateRoomInput, JoinRoomResult, ListRoomsQuery, Room, RoomMember, RoomMemberRole, UpdateRoomInput } from './types';
/** Normalized error for all room API failures. Callers can branch on
 *  `status` (HTTP) or `code` (server error code) without string-matching
 *  the message. */
export declare class RoomApiError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(message: string, status: number, code: string);
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
/**
 * List rooms visible to the caller, optionally filtered.
 * `GET /api/rooms[?state=…&visibility=…&cursor=…&limit=…]`
 *
 * Server returns either a bare `Room[]` or `{ rooms: Room[] }` — both
 * shapes are accepted. Returns `[]` when the server returns nothing.
 */
export declare function listRooms(opts: RoomApiOptions, query?: ListRoomsQuery): Promise<Room[]>;
/** Get a single room by slug. `GET /api/rooms/:slug`.
 *
 * Server returns either a bare `Room` or `{ room: Room }` — both are
 * accepted (same dual-shape policy as `listRooms`).
 */
export declare function getRoom(opts: RoomApiOptions, slug: string): Promise<Room>;
/** Create a new room. `POST /api/rooms`.
 *
 * Server returns either a bare `Room` or `{ room: Room }` — both are
 * accepted. platform-api returns the wrapped shape; older servers and
 * tests may return bare.
 */
export declare function createRoom(opts: RoomApiOptions, input: CreateRoomInput): Promise<Room>;
/** Update mutable fields on an existing room. `PATCH /api/rooms/:slug`. */
export declare function updateRoom(opts: RoomApiOptions, slug: string, patch: UpdateRoomInput): Promise<Room>;
/** Archive a room (soft-delete). `DELETE /api/rooms/:slug`. */
export declare function archiveRoom(opts: RoomApiOptions, slug: string): Promise<void>;
/**
 * Join a room — provisions an SFU session and returns the participant
 * token + id ready to hand to <Stage> or useLVSHangout.
 * `POST /api/rooms/:slug/join`.
 */
export declare function joinRoom(opts: RoomApiOptions, slug: string): Promise<JoinRoomResult>;
/** Leave a room — releases the SFU session.
 *  `POST /api/rooms/:slug/leave`. */
export declare function leaveRoom(opts: RoomApiOptions, slug: string): Promise<void>;
/** List ACL members for a private room.
 *  `GET /api/rooms/:slug/members`. */
export declare function listMembers(opts: RoomApiOptions, slug: string): Promise<RoomMember[]>;
/** Add a member to a private room.
 *  `POST /api/rooms/:slug/members`. */
export declare function addMember(opts: RoomApiOptions, slug: string, userId: string, role?: RoomMemberRole): Promise<RoomMember>;
/** Remove a member from a private room.
 *  `DELETE /api/rooms/:slug/members/:userId`. */
export declare function removeMember(opts: RoomApiOptions, slug: string, userId: string): Promise<void>;
//# sourceMappingURL=api.d.ts.map