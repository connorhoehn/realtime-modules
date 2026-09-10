// realtime-modules/src/client/pipelines/index.ts
//
// Public barrel for @connorhoehn/realtime-modules/client/pipelines.
//
// Live pipeline-run status for a card in a conversation: `pipeline:event`
// frames over the gateway socket merged with platform-api's run snapshot.
// The REST helpers are pure (no React) so scripts and SSR can start and
// approve runs with the same code the hook uses.

export {
  usePipelineRunStatus,
  DEFAULT_STEP_LABELS,
  DEFAULT_PIPELINE_STEP_LABELS,
  DEFAULT_POLL_MS,
  runStatusDetail,
  stepLabelFor,
  retryLabel,
  normalizeEventType,
  statusFromEvent,
  statusFromSnapshot,
  requestPipelineRun,
  approvePipelineRun,
} from './usePipelineRunStatus';

export type {
  PipelineRunStatus,
  PipelineRunPhase,
  PipelineRunDecision,
  PipelineRunRef,
  PipelineRunSnapshot,
  PipelineRunTransport,
  StepLabelTables,
  UsePipelineRunStatusOptions,
} from './usePipelineRunStatus';
