"use strict";
/**
 * FeatureManifest for the agent-streaming (AG-UI server emitter) feature.
 *
 * Surfaced via `@connorhoehn/realtime-modules/agent-streaming`. Consumers
 * (gateway, OrgIQ middleware, etc.) declare this in their feature registry
 * to advertise the route contract + env-var surface without pulling in
 * AgentStreamImpl internals.
 *
 * The agent-streaming feature is HTTP POST + Server-Sent Events; it does
 * not subscribe to or publish on any WebSocket channels, so `channels` is
 * intentionally empty. If future work wires AG-UI events onto WS fan-out,
 * declare the channel patterns here.
 *
 * `AGENT_STREAM_HEARTBEAT_MS` is read by the consumer when constructing
 * `agentStreamMiddleware({ heartbeatMs })`; the middleware itself defaults
 * to 25_000 ms inside `createAgentStream` when the option is omitted.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentStreamingManifest = void 0;
exports.agentStreamingManifest = {
    name: 'agent-streaming',
    version: '0.1.0',
    envVars: {
        AGENT_STREAM_HEARTBEAT_MS: {
            required: false,
            default: '25000',
            description: 'SSE heartbeat interval in milliseconds. Lower to keep aggressive proxies alive.',
        },
    },
    channels: [],
    declarations: undefined,
    dependencies: [],
    install: {
        backendRoutes: '@connorhoehn/realtime-modules/agent-streaming (agentStreamMiddleware)',
        frontendImport: '@connorhoehnslalom/ui-components/agents',
    },
};
//# sourceMappingURL=manifest.js.map