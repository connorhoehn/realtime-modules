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
export { PipelineWsRouter } from './PipelineWsRouter';

export type {
    PipelineBusEnvelope,
    PipelineConfig,
    PipelineEventChannel,
    PipelineFrame,
    PipelineLogger,
    PipelineMessageRouter,
    PipelineMetricsCollector,
    PipelineWsRouterOptions,
} from './types';

export { PipelineWsManifest } from './manifest';
