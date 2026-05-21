"use strict";
// realtime-modules/src/presence/types.ts
//
// Types for the lifted in-process PresenceService.
//
// Lift scope (Wave 2): only the in-memory tracking surface is lifted.
// Gateway-specific concerns left behind:
//   - presenceRegistry dual-write to DC's EntityRegistry
//     (gated by WSG_PRESENCE_REGISTRY_ENABLED)
//   - ownership-cleanup-coordinator integration (_flushRoomPresence)
//   - Redis pub/sub fanout details (consumers wire any
//     MessageRouterContract implementation)
//
// See manifest.ts for tunable env vars.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map