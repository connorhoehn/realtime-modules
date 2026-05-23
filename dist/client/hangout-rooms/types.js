"use strict";
// realtime-modules/src/client/hangout-rooms/types.ts
//
// Public types for the persistent-rooms feature. Mirrors the platform-api
// Room shape — kept in sync via the shared schema (other agent designed
// the server-side Room record; keep these interfaces field-for-field
// equivalent so REST round-trips don't drop data).
//
// `Room` is the canonical resource. `RoomMember` describes ACL entries
// for private rooms. `RoomOccupancy` is the realtime aggregation pushed
// by the gateway's `rooms:index` stream. `JoinRoomResult` mirrors the
// platform-api join response so the consumer can hand the `token` +
// `participantId` to <Stage> / useLVSHangout without an extra round-trip.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map