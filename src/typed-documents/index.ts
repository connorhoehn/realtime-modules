// realtime-modules/src/typed-documents/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/typed-documents`.
//
// Wave 2 lift: WS-side subscription surface for real-time document events
// (comments / reviews / items / workflows). See DocumentEventsService.ts
// for the lift notes. Persistence (DDB typed-document repository, wizard
// CRUD, validation rules, bulk import) is intentionally NOT lifted and
// remains in the gateway / platform-api.

// Named export is the canonical surface. The default export on
// DocumentEventsService.ts is kept for direct subpath imports but is
// deliberately NOT re-forwarded here to avoid collisions when this barrel
// is star-exported from the top-level `realtime-modules` entry.
export { DocumentEventsService } from './DocumentEventsService';

export type {
    DocumentSubscriptionFrame,
    DocumentErrorFrame,
    DocumentEventsConfig,
    DocumentEventsLogger,
    DocumentEventsMessageRouter,
    DocumentEventsMetricsCollector,
    DocumentEventsServiceOptions,
} from './types';

export { TypedDocumentsManifest } from './manifest';
