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
exports.summarizeAll = exports.summarize = exports.kindOf = exports.workTypeOf = exports.isTerminalRunStatus = exports.isActiveRunStatus = exports.isFailedRunStatus = exports.isPipelineKind = exports.isWorkType = exports.emptyRollup = exports.RUN_EVENT_STATUS = exports.RECENT_LIMIT = exports.ROLLUP_RECENT_LIMIT = exports.RUN_ITEM_STATUSES = exports.MAX_ROUTE_ENTRIES = exports.MAX_INSTRUCTION_CHARS = exports.ORIGIN_KINDS = exports.PIPELINE_KINDS = exports.KIND_LABEL = exports.KIND_WORK_TYPE = exports.KIND_MARK = exports.PIPELINE_KIND_ORDER = exports.WORK_TYPE_ORDER = exports.WORK_TYPE_LABEL = exports.reviewPipelineRun = exports.approvePipelineRun = exports.requestPipelineRun = exports.mergeDetails = exports.documentFromOutputs = exports.snippetFromOutline = exports.opsFromApplyOutput = exports.stepTimelineLabel = exports.stepsFromSnapshot = exports.detailsFromSnapshot = exports.enrichTerminalStatus = exports.statusFromSnapshot = exports.statusFromEvent = exports.normalizeEventType = exports.retryLabel = exports.stepLabelFor = exports.isAwaitingReview = exports.suggestionOf = exports.reviewOf = exports.reviewDetail = exports.runStatusDetail = exports.DEFAULT_REVIEW_POLL_MS = exports.DEFAULT_POLL_MS = exports.DEFAULT_PIPELINE_STEP_LABELS = exports.DEFAULT_STEP_LABELS = exports.usePipelineRunStatus = void 0;
exports.PIPELINE_ALL_CHANNEL = exports.newPipelineDraftRequestId = exports.generatePipelineDraft = exports.normalizeCatalogEntry = exports.fetchPipelineCatalog = exports.usePipelineCatalog = exports.mergeRunEvent = exports.applyRunEvent = exports.runEventFromFrame = exports.statusPillFor = exports.relativeTime = exports.groupByWorkType = exports.groupCatalog = exports.sortSummaries = exports.compareSummaries = void 0;
var usePipelineRunStatus_1 = require("./usePipelineRunStatus");
Object.defineProperty(exports, "usePipelineRunStatus", { enumerable: true, get: function () { return usePipelineRunStatus_1.usePipelineRunStatus; } });
Object.defineProperty(exports, "DEFAULT_STEP_LABELS", { enumerable: true, get: function () { return usePipelineRunStatus_1.DEFAULT_STEP_LABELS; } });
Object.defineProperty(exports, "DEFAULT_PIPELINE_STEP_LABELS", { enumerable: true, get: function () { return usePipelineRunStatus_1.DEFAULT_PIPELINE_STEP_LABELS; } });
Object.defineProperty(exports, "DEFAULT_POLL_MS", { enumerable: true, get: function () { return usePipelineRunStatus_1.DEFAULT_POLL_MS; } });
Object.defineProperty(exports, "DEFAULT_REVIEW_POLL_MS", { enumerable: true, get: function () { return usePipelineRunStatus_1.DEFAULT_REVIEW_POLL_MS; } });
Object.defineProperty(exports, "runStatusDetail", { enumerable: true, get: function () { return usePipelineRunStatus_1.runStatusDetail; } });
Object.defineProperty(exports, "reviewDetail", { enumerable: true, get: function () { return usePipelineRunStatus_1.reviewDetail; } });
Object.defineProperty(exports, "reviewOf", { enumerable: true, get: function () { return usePipelineRunStatus_1.reviewOf; } });
Object.defineProperty(exports, "suggestionOf", { enumerable: true, get: function () { return usePipelineRunStatus_1.suggestionOf; } });
Object.defineProperty(exports, "isAwaitingReview", { enumerable: true, get: function () { return usePipelineRunStatus_1.isAwaitingReview; } });
Object.defineProperty(exports, "stepLabelFor", { enumerable: true, get: function () { return usePipelineRunStatus_1.stepLabelFor; } });
Object.defineProperty(exports, "retryLabel", { enumerable: true, get: function () { return usePipelineRunStatus_1.retryLabel; } });
Object.defineProperty(exports, "normalizeEventType", { enumerable: true, get: function () { return usePipelineRunStatus_1.normalizeEventType; } });
Object.defineProperty(exports, "statusFromEvent", { enumerable: true, get: function () { return usePipelineRunStatus_1.statusFromEvent; } });
Object.defineProperty(exports, "statusFromSnapshot", { enumerable: true, get: function () { return usePipelineRunStatus_1.statusFromSnapshot; } });
Object.defineProperty(exports, "enrichTerminalStatus", { enumerable: true, get: function () { return usePipelineRunStatus_1.enrichTerminalStatus; } });
Object.defineProperty(exports, "detailsFromSnapshot", { enumerable: true, get: function () { return usePipelineRunStatus_1.detailsFromSnapshot; } });
Object.defineProperty(exports, "stepsFromSnapshot", { enumerable: true, get: function () { return usePipelineRunStatus_1.stepsFromSnapshot; } });
Object.defineProperty(exports, "stepTimelineLabel", { enumerable: true, get: function () { return usePipelineRunStatus_1.stepTimelineLabel; } });
Object.defineProperty(exports, "opsFromApplyOutput", { enumerable: true, get: function () { return usePipelineRunStatus_1.opsFromApplyOutput; } });
Object.defineProperty(exports, "snippetFromOutline", { enumerable: true, get: function () { return usePipelineRunStatus_1.snippetFromOutline; } });
Object.defineProperty(exports, "documentFromOutputs", { enumerable: true, get: function () { return usePipelineRunStatus_1.documentFromOutputs; } });
Object.defineProperty(exports, "mergeDetails", { enumerable: true, get: function () { return usePipelineRunStatus_1.mergeDetails; } });
Object.defineProperty(exports, "requestPipelineRun", { enumerable: true, get: function () { return usePipelineRunStatus_1.requestPipelineRun; } });
Object.defineProperty(exports, "approvePipelineRun", { enumerable: true, get: function () { return usePipelineRunStatus_1.approvePipelineRun; } });
Object.defineProperty(exports, "reviewPipelineRun", { enumerable: true, get: function () { return usePipelineRunStatus_1.reviewPipelineRun; } });
// v0.88.0 — the pipelines directory: one home for the work-type / kind enum,
// the last-run rollup, the status pill, and the hook that reads the catalog
// (`GET /api/pipelines/defs?include=rollup`) and keeps every row's rollup
// current from the `pipeline:all` run frames — no polling.
var catalog_1 = require("./catalog");
Object.defineProperty(exports, "WORK_TYPE_LABEL", { enumerable: true, get: function () { return catalog_1.WORK_TYPE_LABEL; } });
Object.defineProperty(exports, "WORK_TYPE_ORDER", { enumerable: true, get: function () { return catalog_1.WORK_TYPE_ORDER; } });
Object.defineProperty(exports, "PIPELINE_KIND_ORDER", { enumerable: true, get: function () { return catalog_1.PIPELINE_KIND_ORDER; } });
Object.defineProperty(exports, "KIND_MARK", { enumerable: true, get: function () { return catalog_1.KIND_MARK; } });
Object.defineProperty(exports, "KIND_WORK_TYPE", { enumerable: true, get: function () { return catalog_1.KIND_WORK_TYPE; } });
Object.defineProperty(exports, "KIND_LABEL", { enumerable: true, get: function () { return catalog_1.KIND_LABEL; } });
Object.defineProperty(exports, "PIPELINE_KINDS", { enumerable: true, get: function () { return catalog_1.PIPELINE_KINDS; } });
Object.defineProperty(exports, "ORIGIN_KINDS", { enumerable: true, get: function () { return catalog_1.ORIGIN_KINDS; } });
Object.defineProperty(exports, "MAX_INSTRUCTION_CHARS", { enumerable: true, get: function () { return catalog_1.MAX_INSTRUCTION_CHARS; } });
Object.defineProperty(exports, "MAX_ROUTE_ENTRIES", { enumerable: true, get: function () { return catalog_1.MAX_ROUTE_ENTRIES; } });
Object.defineProperty(exports, "RUN_ITEM_STATUSES", { enumerable: true, get: function () { return catalog_1.RUN_ITEM_STATUSES; } });
Object.defineProperty(exports, "ROLLUP_RECENT_LIMIT", { enumerable: true, get: function () { return catalog_1.ROLLUP_RECENT_LIMIT; } });
Object.defineProperty(exports, "RECENT_LIMIT", { enumerable: true, get: function () { return catalog_1.RECENT_LIMIT; } });
Object.defineProperty(exports, "RUN_EVENT_STATUS", { enumerable: true, get: function () { return catalog_1.RUN_EVENT_STATUS; } });
Object.defineProperty(exports, "emptyRollup", { enumerable: true, get: function () { return catalog_1.emptyRollup; } });
Object.defineProperty(exports, "isWorkType", { enumerable: true, get: function () { return catalog_1.isWorkType; } });
Object.defineProperty(exports, "isPipelineKind", { enumerable: true, get: function () { return catalog_1.isPipelineKind; } });
Object.defineProperty(exports, "isFailedRunStatus", { enumerable: true, get: function () { return catalog_1.isFailedRunStatus; } });
Object.defineProperty(exports, "isActiveRunStatus", { enumerable: true, get: function () { return catalog_1.isActiveRunStatus; } });
Object.defineProperty(exports, "isTerminalRunStatus", { enumerable: true, get: function () { return catalog_1.isTerminalRunStatus; } });
Object.defineProperty(exports, "workTypeOf", { enumerable: true, get: function () { return catalog_1.workTypeOf; } });
Object.defineProperty(exports, "kindOf", { enumerable: true, get: function () { return catalog_1.kindOf; } });
Object.defineProperty(exports, "summarize", { enumerable: true, get: function () { return catalog_1.summarize; } });
Object.defineProperty(exports, "summarizeAll", { enumerable: true, get: function () { return catalog_1.summarizeAll; } });
Object.defineProperty(exports, "compareSummaries", { enumerable: true, get: function () { return catalog_1.compareSummaries; } });
Object.defineProperty(exports, "sortSummaries", { enumerable: true, get: function () { return catalog_1.sortSummaries; } });
Object.defineProperty(exports, "groupCatalog", { enumerable: true, get: function () { return catalog_1.groupCatalog; } });
Object.defineProperty(exports, "groupByWorkType", { enumerable: true, get: function () { return catalog_1.groupByWorkType; } });
Object.defineProperty(exports, "relativeTime", { enumerable: true, get: function () { return catalog_1.relativeTime; } });
Object.defineProperty(exports, "statusPillFor", { enumerable: true, get: function () { return catalog_1.statusPillFor; } });
Object.defineProperty(exports, "runEventFromFrame", { enumerable: true, get: function () { return catalog_1.runEventFromFrame; } });
Object.defineProperty(exports, "applyRunEvent", { enumerable: true, get: function () { return catalog_1.applyRunEvent; } });
Object.defineProperty(exports, "mergeRunEvent", { enumerable: true, get: function () { return catalog_1.mergeRunEvent; } });
var usePipelineCatalog_1 = require("./usePipelineCatalog");
Object.defineProperty(exports, "usePipelineCatalog", { enumerable: true, get: function () { return usePipelineCatalog_1.usePipelineCatalog; } });
Object.defineProperty(exports, "fetchPipelineCatalog", { enumerable: true, get: function () { return usePipelineCatalog_1.fetchPipelineCatalog; } });
Object.defineProperty(exports, "normalizeCatalogEntry", { enumerable: true, get: function () { return usePipelineCatalog_1.normalizeCatalogEntry; } });
Object.defineProperty(exports, "generatePipelineDraft", { enumerable: true, get: function () { return usePipelineCatalog_1.generatePipelineDraft; } });
Object.defineProperty(exports, "newPipelineDraftRequestId", { enumerable: true, get: function () { return usePipelineCatalog_1.newPipelineDraftRequestId; } });
Object.defineProperty(exports, "PIPELINE_ALL_CHANNEL", { enumerable: true, get: function () { return usePipelineCatalog_1.PIPELINE_ALL_CHANNEL; } });
//# sourceMappingURL=index.js.map