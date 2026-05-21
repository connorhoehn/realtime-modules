"use strict";
// realtime-modules/src/pipeline/types.ts
//
// Wire shapes + construction-time tunables for the lifted PipelineWsRouter.
//
// Lift scope (Wave 2): the WS-side pipeline subscription surface only.
//   - subscribe / unsubscribe / disconnect for pipeline channels
//   - emitEvent: BusEvent → `pipeline:event` frame projection
//   - _broadcastToLocalSubscribers local fallback
//   - _isValidChannel validation helper
//
// Deliberately left in gateway:
//   - handleTrigger / handleCancel / handleResolveApproval /
//     handleResumeFromStep / handleGetRun / handleGetHistory /
//     handleResolveBreakpoint (delegate to PipelineModule + audit log + authz)
//   - audit-log wiring (Phase 52)
//   - approval authz predicate (Phase 52)
//   - tracing instrumentation (Phase 51)
//   - PipelineModule + pipelineEventSource references
//   - mock store / dev shim (`_mockTrigger`, `_mockGetRun`, `_mockGetHistory`,
//     `_emitMock`)
//   - test-emit / sim-emit dev actions
//   - HTTP webhook trigger path (triggerFromWebhook)
//
// See manifest.ts for tunable env vars.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map