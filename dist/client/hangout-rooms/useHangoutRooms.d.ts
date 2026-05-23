import { RoomApiError } from './api';
import type { CreateRoomInput, JoinRoomResult, ListRoomsQuery, Room } from './types';
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
export declare function useHangoutRooms(opts?: UseHangoutRoomsOptions): UseHangoutRoomsResult;
//# sourceMappingURL=useHangoutRooms.d.ts.map