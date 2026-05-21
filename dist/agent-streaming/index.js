"use strict";
/**
 * @connorhoehn/realtime-modules/agent-streaming — barrel export.
 *
 * Server-side emitter for AG-UI v0.1.x. Pairs with
 * `@connorhoehnslalom/ui-components/agents` on the client.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentStreamingManifest = exports.agentStreamingManifest = exports.agentStreamMiddleware = exports.createAgentStream = exports.validateJsonPatch = exports.AgentStreamImpl = void 0;
var AgentStream_1 = require("./AgentStream");
Object.defineProperty(exports, "AgentStreamImpl", { enumerable: true, get: function () { return AgentStream_1.AgentStreamImpl; } });
Object.defineProperty(exports, "validateJsonPatch", { enumerable: true, get: function () { return AgentStream_1.validateJsonPatch; } });
var createAgentStream_1 = require("./createAgentStream");
Object.defineProperty(exports, "createAgentStream", { enumerable: true, get: function () { return createAgentStream_1.createAgentStream; } });
var agentStreamMiddleware_1 = require("./agentStreamMiddleware");
Object.defineProperty(exports, "agentStreamMiddleware", { enumerable: true, get: function () { return agentStreamMiddleware_1.agentStreamMiddleware; } });
// FeatureManifest for the agent-streaming feature. Consumers (gateway,
// OrgIQ middleware, etc.) declare this in their feature registry to
// advertise the route + env-var contract.
//
// Re-exported under both the original `AgentStreamingManifest` name (for
// callers that imported the inline export pre-extraction) and the new
// `agentStreamingManifest` name (matches the lowercased convention used
// for sibling manifests like `crdtManifest`).
var manifest_1 = require("./manifest");
Object.defineProperty(exports, "agentStreamingManifest", { enumerable: true, get: function () { return manifest_1.agentStreamingManifest; } });
var manifest_2 = require("./manifest");
Object.defineProperty(exports, "AgentStreamingManifest", { enumerable: true, get: function () { return manifest_2.agentStreamingManifest; } });
//# sourceMappingURL=index.js.map