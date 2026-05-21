"use strict";
// realtime-modules/src/cursor/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/cursor`.
//
// Wave 2 catch-up lift: pure in-memory cursor fan-out service with a
// periodic TTL sweep. See CursorService.ts for the lift notes.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CursorManifest = exports.DEFAULT_THROTTLE_INTERVAL_MS = exports.DEFAULT_SUPPORTED_MODES = exports.DEFAULT_CURSOR_TTL_MS = exports.DEFAULT_CLEANUP_INTERVAL_MS = exports.CursorService = void 0;
// Named export is the canonical surface. The default export on
// CursorService.ts is kept for direct subpath imports
// (`import CursorService from '.../cursor/CursorService'`) but is
// deliberately NOT re-forwarded here to avoid collisions when this barrel
// is star-exported from the top-level `realtime-modules` entry.
var CursorService_1 = require("./CursorService");
Object.defineProperty(exports, "CursorService", { enumerable: true, get: function () { return CursorService_1.CursorService; } });
// Note: `DEFAULT_ERROR_CODE` is intentionally NOT re-forwarded from this
// barrel — it collides with the same-named constant in the reactions
// module when both are star-exported from the top-level package entry.
// Consumers that need it can import directly from `./cursor/types`.
var types_1 = require("./types");
Object.defineProperty(exports, "DEFAULT_CLEANUP_INTERVAL_MS", { enumerable: true, get: function () { return types_1.DEFAULT_CLEANUP_INTERVAL_MS; } });
Object.defineProperty(exports, "DEFAULT_CURSOR_TTL_MS", { enumerable: true, get: function () { return types_1.DEFAULT_CURSOR_TTL_MS; } });
Object.defineProperty(exports, "DEFAULT_SUPPORTED_MODES", { enumerable: true, get: function () { return types_1.DEFAULT_SUPPORTED_MODES; } });
Object.defineProperty(exports, "DEFAULT_THROTTLE_INTERVAL_MS", { enumerable: true, get: function () { return types_1.DEFAULT_THROTTLE_INTERVAL_MS; } });
var manifest_1 = require("./manifest");
Object.defineProperty(exports, "CursorManifest", { enumerable: true, get: function () { return manifest_1.CursorManifest; } });
//# sourceMappingURL=index.js.map