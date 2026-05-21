"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PipelineWsManifest = exports.PipelineWsRouter = void 0;
// realtime-modules/src/pipeline/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/pipeline`.
//
// Wave 2 lift: WS-side pipeline subscription fan-out + frame projection.
// See PipelineWsRouter.ts for the lift notes.
//
// Named export is the canonical surface. The default export on
// PipelineWsRouter.ts is kept for direct subpath imports
// (`import PipelineWsRouter from '.../pipeline/PipelineWsRouter'`) but is
// deliberately NOT re-forwarded here to avoid collisions when this
// barrel is star-exported from the top-level `realtime-modules` entry.
var PipelineWsRouter_1 = require("./PipelineWsRouter");
Object.defineProperty(exports, "PipelineWsRouter", { enumerable: true, get: function () { return PipelineWsRouter_1.PipelineWsRouter; } });
var manifest_1 = require("./manifest");
Object.defineProperty(exports, "PipelineWsManifest", { enumerable: true, get: function () { return manifest_1.PipelineWsManifest; } });
//# sourceMappingURL=index.js.map