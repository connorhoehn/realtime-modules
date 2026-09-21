"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORK_GRAPH_V2_LIMITS = exports.WORK_GRAPH_SCHEMA_VERSION_V2 = void 0;
/** Opt-in readers precede v2 producers. Existing v1 contracts remain exact. */
exports.WORK_GRAPH_SCHEMA_VERSION_V2 = 2;
exports.WORK_GRAPH_V2_LIMITS = { efforts: 50, revisions: 100, anchors: 200, tools: 16, eventBuckets: 1500, detailLines: 4, links: 16, transcriptSegments: 500, snapshotBytes: 1024 * 1024 };
//# sourceMappingURL=contractsV2.js.map