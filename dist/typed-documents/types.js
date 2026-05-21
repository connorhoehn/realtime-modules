"use strict";
// realtime-modules/src/typed-documents/types.ts
//
// Wire shapes + construction-time tunables for the lifted in-memory
// DocumentEventsService.
//
// Lift scope (Wave 2): WS subscription tracking + subscribe/unsubscribe
// action handlers only. Everything persistence-side stays in the gateway
// (the typed-document repository, the wizard CRUD endpoints, validation
// rules, bulk-import logic). This module is intentionally agnostic of how
// document events are PUBLISHED — gateway / social-api / platform-api
// publish directly to the `doc-comments:{documentId}` and `doc:{documentId}`
// Redis channels and the module just owns the subscriber half.
//
// See manifest.ts for tunable env vars (only the documentId length cap is
// exposed today; the channel pattern is hard-coded for compat).
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map