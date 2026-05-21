"use strict";
// realtime-modules/src/social/types.ts
//
// Wire shapes + construction-time tunables for the lifted in-memory
// SocialService.
//
// Lift scope (Wave 2): the WS-side social-event subscription surface
// only.
//   - subscribe / unsubscribe / disconnect for social channels (per room)
//   - channelId validation (max length cap)
//   - frame shape ({ type: 'social', action, channelId, timestamp })
//
// Deliberately left in gateway / platform-api:
//   - all social-api CRUD (post, comment, like, member, …) — platform-api
//   - all publishing / broadcasting from social-api's Redis side —
//     platform-api's BroadcastService is the producer; this service is
//     subscribe-only on the WS edge.
//
// See manifest.ts for tunable env vars.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map