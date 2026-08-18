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
export { IngestService } from './IngestService';

export type {
    IngestConfig,
    IngestEvent,
    IngestEventChannel,
    IngestFrame,
    IngestLogger,
    IngestMessageRouter,
    IngestMetricsCollector,
    IngestServiceOptions,
} from './types';

export { IngestManifest } from './manifest';
