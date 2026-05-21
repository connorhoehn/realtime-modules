"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IngestManifest = exports.IngestService = void 0;
// realtime-modules/src/ingest/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/ingest`.
//
// Wave 2 lift: WS-side ingest subscription fan-out. Pure in-memory.
// See IngestService.ts for the lift notes.
//
// Named export is the canonical surface. The default export on
// IngestService.ts is kept for direct subpath imports
// (`import IngestService from '.../ingest/IngestService'`) but is
// deliberately NOT re-forwarded here to avoid collisions when this
// barrel is star-exported from the top-level `realtime-modules` entry.
var IngestService_1 = require("./IngestService");
Object.defineProperty(exports, "IngestService", { enumerable: true, get: function () { return IngestService_1.IngestService; } });
var manifest_1 = require("./manifest");
Object.defineProperty(exports, "IngestManifest", { enumerable: true, get: function () { return manifest_1.IngestManifest; } });
//# sourceMappingURL=index.js.map