"use strict";
// realtime-modules/src/reactions/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/reactions`.
//
// Emoji-reaction fan-out. Two behaviours in one service, split by whether a
// reaction names a target:
//   - no targetId  → ephemeral. The floating emoji thrown at a call: fanned
//     out, kept in a small per-channel ring, never stored.
//   - targetId set → durable, when a `ReactionStore` is configured. A message
//     reaction is state, not an event: it is written before it is broadcast,
//     replayed to every new subscriber, and removable by its owner.
// See ReactionService.ts for the lift notes.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReactionsManifest = exports.DEFAULT_ERROR_CODE = exports.DEFAULT_AVAILABLE_REACTIONS = exports.ReactionService = void 0;
// Named export is the canonical surface. The default export on
// ReactionService.ts is kept for direct subpath imports
// (`import ReactionService from '.../reactions/ReactionService'`) but is
// deliberately NOT re-forwarded here to avoid collisions when this
// barrel is star-exported from the top-level `realtime-modules` entry.
var ReactionService_1 = require("./ReactionService");
Object.defineProperty(exports, "ReactionService", { enumerable: true, get: function () { return ReactionService_1.ReactionService; } });
var types_1 = require("./types");
Object.defineProperty(exports, "DEFAULT_AVAILABLE_REACTIONS", { enumerable: true, get: function () { return types_1.DEFAULT_AVAILABLE_REACTIONS; } });
Object.defineProperty(exports, "DEFAULT_ERROR_CODE", { enumerable: true, get: function () { return types_1.DEFAULT_ERROR_CODE; } });
var manifest_1 = require("./manifest");
Object.defineProperty(exports, "ReactionsManifest", { enumerable: true, get: function () { return manifest_1.ReactionsManifest; } });
//# sourceMappingURL=index.js.map