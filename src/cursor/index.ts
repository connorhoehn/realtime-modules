// realtime-modules/src/cursor/index.ts
//
// Subpath export: `@connorhoehn/realtime-modules/cursor`.
//
// Wave 2 catch-up lift: pure in-memory cursor fan-out service with a
// periodic TTL sweep. See CursorService.ts for the lift notes.

// Named export is the canonical surface. The default export on
// CursorService.ts is kept for direct subpath imports
// (`import CursorService from '.../cursor/CursorService'`) but is
// deliberately NOT re-forwarded here to avoid collisions when this barrel
// is star-exported from the top-level `realtime-modules` entry.
export { CursorService } from './CursorService';

// Note: `DEFAULT_ERROR_CODE` is intentionally NOT re-forwarded from this
// barrel — it collides with the same-named constant in the reactions
// module when both are star-exported from the top-level package entry.
// Consumers that need it can import directly from `./cursor/types`.
export {
    DEFAULT_CLEANUP_INTERVAL_MS,
    DEFAULT_CURSOR_TTL_MS,
    DEFAULT_SUPPORTED_MODES,
    DEFAULT_THROTTLE_INTERVAL_MS,
    type CursorConfig,
    type CursorData,
    type CursorErrorFrame,
    type CursorLogger,
    type CursorMessageRouter,
    type CursorMetricsCollector,
    type CursorModeConfig,
    type CursorServiceOptions,
    type CursorUpdate,
} from './types';

export { CursorManifest } from './manifest';
