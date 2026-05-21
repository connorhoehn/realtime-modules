"use strict";
// realtime-modules/src/cursor/types.ts
//
// Wire shapes + construction-time tunables for the lifted in-memory
// CursorService.
//
// Lift scope (Wave 2 catch-up): pure in-memory cursor fan-out. No
// persistence, no DDB, no Redis. Gateway-specific concerns left behind:
//   - ownership-cleanup-coordinator integration (_cleanupRoom / onLost)
//   - enforceChannelPermission interceptor (replaced with `authorizeChannel`)
//   - ErrorCodes / createErrorResponse coupling (inlined to minimal shape)
//
// See manifest.ts for tunable env vars.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CLEANUP_INTERVAL_MS = exports.DEFAULT_CURSOR_TTL_MS = exports.DEFAULT_THROTTLE_INTERVAL_MS = exports.DEFAULT_ERROR_CODE = exports.DEFAULT_SUPPORTED_MODES = void 0;
/**
 * Built-in cursor-mode catalog (freeform / table / text / canvas). Frozen
 * so consumers don't accidentally mutate the shared module-level object.
 */
exports.DEFAULT_SUPPORTED_MODES = Object.freeze({
    freeform: {
        name: 'Freeform Cursor',
        description: 'Traditional mouse cursor tracking (Miro, Figma)',
        requiredFields: ['x', 'y'],
        optionalFields: ['viewport', 'zoom'],
    },
    table: {
        name: 'Table Cell Cursor',
        description: 'Cell-based cursor tracking (Excel, Sheets)',
        requiredFields: ['row', 'col'],
        optionalFields: ['sheet', 'range'],
    },
    text: {
        name: 'Text Position Cursor',
        description: 'Text position tracking (Google Docs, Word)',
        requiredFields: ['position'],
        optionalFields: ['paragraph', 'line', 'selection'],
    },
    canvas: {
        name: 'Canvas Cursor',
        description: 'Canvas-based cursor tracking with tools',
        requiredFields: ['x', 'y'],
        optionalFields: ['tool', 'brush', 'layer'],
    },
});
/** Default error code emitted when sendError is called without an explicit code. */
exports.DEFAULT_ERROR_CODE = 'SERVICE_INTERNAL_ERROR';
/** Default tunables — keep in sync with manifest env-var defaults. */
exports.DEFAULT_THROTTLE_INTERVAL_MS = 250;
exports.DEFAULT_CURSOR_TTL_MS = 30000;
exports.DEFAULT_CLEANUP_INTERVAL_MS = 10000;
//# sourceMappingURL=types.js.map