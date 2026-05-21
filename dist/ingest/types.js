"use strict";
// realtime-modules/src/ingest/types.ts
//
// Wire shapes + construction-time tunables for the lifted in-memory
// IngestService.
//
// Lift scope (Wave 2): the WS-side ingest subscription surface only.
//   - subscribe / unsubscribe / disconnect for ingest channels
//   - emitEvent: broadcast an IngestEvent to channel subscribers
//   - _broadcastToLocalSubscribers local fallback
//   - _isValidChannel validation helper
//
// Deliberately left in gateway:
//   - ingest-bridge / ingest-relay (event-bus → emitEvent plumbing)
//   - any DDB persistence
//   - the platform-api ingest engine itself (separate service)
//
// See manifest.ts for tunable env vars.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map