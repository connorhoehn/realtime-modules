"use strict";
/**
 * Dependency-free contracts for the Active now shared work graph.
 *
 * Source records are private service-to-service data. Viewer records are the
 * only shapes that may cross an HTTP or WebSocket boundary to a browser.
 * Hosts must obtain source authorization decisions before calling projection
 * helpers; this package never infers access from presence or source metadata.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORK_GRAPH_LIMITS = exports.WORK_GRAPH_SCHEMA_VERSION = void 0;
exports.WORK_GRAPH_SCHEMA_VERSION = 1;
exports.WORK_GRAPH_LIMITS = {
    idLength: 128,
    /** Signed snapshot/replay cursors carry the bound query scope and HMAC. */
    cursorLength: 4_096,
    labelLength: 160,
    descriptionLength: 1_000,
    timezoneLength: 64,
    sourceEventBytes: 32 * 1024,
    referenceBytes: 2 * 1024,
    pageNodes: 100,
    pageEdges: 200,
    snapshotNodes: 250,
    snapshotEdges: 500,
    deltaOperations: 200,
    deltaBytes: 256 * 1024,
    replayBatches: 1_000,
    replayAgeMs: 15 * 60 * 1_000,
    heartbeatFreshMs: 45 * 1_000,
    heartbeatStaleMs: 5 * 60 * 1_000,
    eventRetentionDays: 30,
    minimumSharingMs: 5 * 60 * 1_000,
    maximumSharingMs: 24 * 60 * 60 * 1_000,
    maximumHistorySharingMs: 7 * 24 * 60 * 60 * 1_000,
    maximumCollaborationRequestMs: 24 * 60 * 60 * 1_000,
};
//# sourceMappingURL=contracts.js.map