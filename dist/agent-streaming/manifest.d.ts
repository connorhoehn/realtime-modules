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
import type { FeatureManifest } from '../feature-manifest/types';
export declare const agentStreamingManifest: FeatureManifest;
//# sourceMappingURL=manifest.d.ts.map