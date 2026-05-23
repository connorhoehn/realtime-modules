// realtime-modules/src/client/hangout-rooms/index.ts
//
// Public barrel for the @connorhoehn/realtime-modules/client/hangout-rooms
// subpath. Consumer apps (gateway frontend, OrgIQ, etc.) import the
// hooks + types from here. The REST `api.ts` functions are also
// re-exported so non-React callers (SSR, scripts) can use the same
// transport directly without pulling in React.

// Types
export type {
  CreateRoomInput,
  JoinRoomResult,
  ListRoomsQuery,
  Room,
  RoomMember,
  RoomMemberRole,
  RoomOccupancy,
  RoomSettings,
  RoomState,
  RoomVisibility,
  UpdateRoomInput,
} from './types';

// REST client (pure — no React)
export {
  RoomApiError,
  addMember,
  archiveRoom,
  createRoom,
  getRoom,
  joinRoom,
  leaveRoom,
  listMembers,
  listRooms,
  removeMember,
  updateRoom,
  type RoomApiOptions,
} from './api';

// Hooks
export {
  useHangoutRooms,
  type RoomEvent,
  type RoomEventSubscriber,
  type UseHangoutRoomsOptions,
  type UseHangoutRoomsResult,
} from './useHangoutRooms';

export {
  useRoomOccupancy,
  type RoomsIndexSubscriber,
  type UseRoomOccupancyOptions,
  type UseRoomOccupancyResult,
} from './useRoomOccupancy';

export {
  useRoomMembers,
  type RoomMemberEvent,
  type RoomMemberEventSubscriber,
  type UseRoomMembersOptions,
  type UseRoomMembersResult,
} from './useRoomMembers';
