"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SocialManifest = exports.SocialService = void 0;
// realtime-modules/src/social/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/social`.
//
// Wave 2 lift: WS-side social-event subscription fan-out. Pure
// in-memory. See SocialService.ts for the lift notes.
//
// Named export is the canonical surface. The default export on
// SocialService.ts is kept for direct subpath imports
// (`import SocialService from '.../social/SocialService'`) but is
// deliberately NOT re-forwarded here to avoid collisions when this
// barrel is star-exported from the top-level `realtime-modules` entry.
var SocialService_1 = require("./SocialService");
Object.defineProperty(exports, "SocialService", { enumerable: true, get: function () { return SocialService_1.SocialService; } });
var manifest_1 = require("./manifest");
Object.defineProperty(exports, "SocialManifest", { enumerable: true, get: function () { return manifest_1.SocialManifest; } });
//# sourceMappingURL=index.js.map