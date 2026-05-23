import { RoomApiError } from './api';
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
export type RoomMemberEventSubscriber = (handler: (evt: RoomMemberEvent) => void) => () => void;
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
export declare function useRoomMembers(slug: string | null, opts?: UseRoomMembersOptions): UseRoomMembersResult;
//# sourceMappingURL=useRoomMembers.d.ts.map