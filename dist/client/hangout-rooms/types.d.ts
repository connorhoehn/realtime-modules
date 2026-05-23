/** Visibility of a persistent hangout room. */
export type RoomVisibility = 'org' | 'private';
/** Lifecycle state. Archived rooms are read-only but still listable. */
export type RoomState = 'active' | 'archived';
/** Membership role for private rooms. Owners can add/remove members. */
export type RoomMemberRole = 'owner' | 'member';
/** Per-room behavior flags. Editable by owners via `updateRoom`. */
export interface RoomSettings {
    /** Disable video tracks entirely; only audio is published. */
    audioOnly: boolean;
    /** When true, server-side recording is permitted (off by default). */
    recordingEnabled: boolean;
    /** Advisory soft cap on concurrent participants. UI may warn at this
     *  threshold; the SFU enforces a separate hard cap. */
    softCap: number;
}
/** Canonical Room resource — matches the platform-api persisted shape. */
export interface Room {
    orgId: string;
    roomId: string;
    /** URL-safe identifier — primary key for REST routes. */
    slug: string;
    name: string;
    description?: string;
    createdBy: string;
    /** ISO-8601 timestamp. */
    createdAt: string;
    visibility: RoomVisibility;
    settings: RoomSettings;
    state: RoomState;
    /** ISO-8601 — last time a participant joined or left. */
    lastActiveAt: string;
}
/** ACL entry for a private room. */
export interface RoomMember {
    roomId: string;
    userId: string;
    role: RoomMemberRole;
    /** ISO-8601 timestamp the member was added. */
    addedAt: string;
}
/** Live occupancy summary for one room, pushed by the gateway. */
export interface RoomOccupancy {
    slug: string;
    count: number;
    members: Array<{
        userId: string;
        displayName?: string;
        participantId: string;
    }>;
}
/** Input for `createRoom`. `visibility` defaults to `org`; `settings`
 *  fields default server-side (audioOnly=false, recordingEnabled=false,
 *  softCap=server default). */
export interface CreateRoomInput {
    name: string;
    description?: string;
    visibility?: RoomVisibility;
    settings?: Partial<RoomSettings>;
}
/** Patch shape for `updateRoom`. All fields optional; omitted fields
 *  are unchanged. `settings` is shallow-merged server-side. */
export interface UpdateRoomInput {
    name?: string;
    description?: string;
    visibility?: RoomVisibility;
    settings?: Partial<RoomSettings>;
}
/** Result of joining a room — carries everything <Stage> /
 *  useLVSHangout needs to open WHIP/WHEP without a second round-trip. */
export interface JoinRoomResult {
    room: Room;
    sessionId: string;
    /** SFU participant token (bearer for WHIP/WHEP). Suitable to pass as
     *  `stageToken` to useLVSHangout. */
    token: string;
    /** Per-tab unique participant id. Pass to useLVSHangout. */
    participantId: string;
}
/** Query filter for `listRooms`. All fields optional. */
export interface ListRoomsQuery {
    /** Filter by state. Default server-side: 'active'. */
    state?: RoomState;
    /** Filter by visibility. */
    visibility?: RoomVisibility;
    /** Server-side pagination cursor. */
    cursor?: string;
    /** Page size hint. */
    limit?: number;
}
//# sourceMappingURL=types.d.ts.map