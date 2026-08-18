"use strict";
// realtime-modules/src/notification/types.ts
//
// Shared structural types for the gateway-side notification service.
//
// Ground truth for the wire contract is the client hook at
// realtime-modules/src/client/useNotifications.ts:9-24. These types are a
// gateway-local structural mirror — we deliberately do NOT `import type`
// from `@connorhoehn/realtime-modules` here because ts-jest's tsconfig uses
// `moduleResolution: 'node'` which doesn't honour the package's subpath
// `exports` map (same workaround other gateway adapters use). The runtime
// contract is preserved; this is purely a build-tool concern.
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map