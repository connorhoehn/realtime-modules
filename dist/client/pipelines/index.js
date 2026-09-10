"use strict";
// realtime-modules/src/client/pipelines/index.ts
//
// Public barrel for @connorhoehn/realtime-modules/client/pipelines.
//
// Live pipeline-run status for a card in a conversation: `pipeline:event`
// frames over the gateway socket merged with platform-api's run snapshot.
// The REST helpers are pure (no React) so scripts and SSR can start and
// approve runs with the same code the hook uses.
Object.defineProperty(exports, "__esModule", { value: true });
exports.approvePipelineRun = exports.requestPipelineRun = exports.statusFromSnapshot = exports.statusFromEvent = exports.normalizeEventType = exports.retryLabel = exports.stepLabelFor = exports.runStatusDetail = exports.DEFAULT_POLL_MS = exports.DEFAULT_PIPELINE_STEP_LABELS = exports.DEFAULT_STEP_LABELS = exports.usePipelineRunStatus = void 0;
var usePipelineRunStatus_1 = require("./usePipelineRunStatus");
Object.defineProperty(exports, "usePipelineRunStatus", { enumerable: true, get: function () { return usePipelineRunStatus_1.usePipelineRunStatus; } });
Object.defineProperty(exports, "DEFAULT_STEP_LABELS", { enumerable: true, get: function () { return usePipelineRunStatus_1.DEFAULT_STEP_LABELS; } });
Object.defineProperty(exports, "DEFAULT_PIPELINE_STEP_LABELS", { enumerable: true, get: function () { return usePipelineRunStatus_1.DEFAULT_PIPELINE_STEP_LABELS; } });
Object.defineProperty(exports, "DEFAULT_POLL_MS", { enumerable: true, get: function () { return usePipelineRunStatus_1.DEFAULT_POLL_MS; } });
Object.defineProperty(exports, "runStatusDetail", { enumerable: true, get: function () { return usePipelineRunStatus_1.runStatusDetail; } });
Object.defineProperty(exports, "stepLabelFor", { enumerable: true, get: function () { return usePipelineRunStatus_1.stepLabelFor; } });
Object.defineProperty(exports, "retryLabel", { enumerable: true, get: function () { return usePipelineRunStatus_1.retryLabel; } });
Object.defineProperty(exports, "normalizeEventType", { enumerable: true, get: function () { return usePipelineRunStatus_1.normalizeEventType; } });
Object.defineProperty(exports, "statusFromEvent", { enumerable: true, get: function () { return usePipelineRunStatus_1.statusFromEvent; } });
Object.defineProperty(exports, "statusFromSnapshot", { enumerable: true, get: function () { return usePipelineRunStatus_1.statusFromSnapshot; } });
Object.defineProperty(exports, "requestPipelineRun", { enumerable: true, get: function () { return usePipelineRunStatus_1.requestPipelineRun; } });
Object.defineProperty(exports, "approvePipelineRun", { enumerable: true, get: function () { return usePipelineRunStatus_1.approvePipelineRun; } });
//# sourceMappingURL=index.js.map