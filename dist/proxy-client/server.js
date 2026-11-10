"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
const service_runtime_1 = require("@connorhoehn/service-runtime");
const GatewayProxyClient_1 = require("./GatewayProxyClient");
(0, GatewayProxyClient_1.registerServiceRequestHeaders)(service_runtime_1.createServiceRequestHeaders);
__exportStar(require("./index"), exports);
//# sourceMappingURL=server.js.map