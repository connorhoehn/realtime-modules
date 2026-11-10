// realtime-modules/src/proxy-client/server.ts
//
// Server entry for the HTTP-shim client:
//   import { GatewayProxyClient } from '@connorhoehn/realtime-modules/proxy-client/server';
//
// Same exports as `./proxy-client`, plus a static import of
// @connorhoehn/service-runtime so request signing works in server code that
// is bundled (esbuild Lambda bundles do not follow the lazy require the
// browser-safe entry uses). Never import this from browser code: service-runtime
// is Node-only.

import { createServiceRequestHeaders } from '@connorhoehn/service-runtime';
import { registerServiceRequestHeaders } from './GatewayProxyClient';

registerServiceRequestHeaders(createServiceRequestHeaders);

export * from './index';
