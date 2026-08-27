"use strict";
// realtime-modules/src/adapters/excalidraw/types.ts
//
// Structural types for the Excalidraw binding.
//
// This adapter deliberately does NOT import `@excalidraw/excalidraw`. The
// binding only needs three properties off an element (`id`, `version`,
// `versionNonce`) plus the fractional `index` for z-order, and every one of
// those is a plain JSON scalar. Typing structurally means:
//
//   - realtime-modules installs with no Excalidraw dependency at all, so the
//     `./client` surface stays as light as it is today;
//   - the binding is testable in Node with plain objects (no canvas, no DOM);
//   - an Excalidraw major bump cannot break this package's type-check.
//
// The consuming component (ui-components' CollaborativeExcalidraw) owns the
// real Excalidraw types and casts at that boundary — one cast in one file
// instead of a hard dep threaded through the library.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map