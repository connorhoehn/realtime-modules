"use strict";
// realtime-modules/src/reactions/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/reactions`.
//
// Wave 2 lift: pure in-memory emoji-reaction fan-out service with a small
// LRU history per channel. See ReactionService.ts for the lift notes.
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