/**
 * @connorhoehn/realtime-modules/agent-streaming — barrel export.
 *
 * Server-side emitter for AG-UI v0.1.x. Pairs with
 * `@connorhoehnslalom/ui-components/agents` on the client.
 */

export type {
  AgentStream,
  AgUiEvent,
  AgUiEventType,
  AgUiRole,
  JsonPatchOp,
  // Lifecycle
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  StepStartedEvent,
  StepFinishedEvent,
  // Text — verbose
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageChunkEvent,
  // Tool calls
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallChunkEvent,
  // State
  StateSnapshotEvent,
  StateDeltaEvent,
  MessagesSnapshotEvent,
  // Activity
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  // Reasoning
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageChunkEvent,
  ReasoningStartEvent,
  ReasoningEndEvent,
  ReasoningEncryptedValueEvent,
  // Extensions
  CustomEvent,
  RawEvent,
  MetaEvent,
} from './types';

export { AgentStreamImpl, validateJsonPatch } from './AgentStream';
export type { StreamSink, AgentStreamOptions } from './AgentStream';

export {
  createAgentStream,
  type CreateAgentStreamOptions,
} from './createAgentStream';

export {
  agentStreamMiddleware,
  type AgentStreamHandler,
  type AgentStreamMiddlewareOptions,
  type BufferedProviderResult,
  type StreamingProviderResult,
  type ProviderResult,
} from './agentStreamMiddleware';

// FeatureManifest for the agent-streaming feature. Consumers (gateway,
// OrgIQ middleware, etc.) declare this in their feature registry to
// advertise the route + env-var contract.
//
// Re-exported under both the original `AgentStreamingManifest` name (for
// callers that imported the inline export pre-extraction) and the new
// `agentStreamingManifest` name (matches the lowercased convention used
// for sibling manifests like `crdtManifest`).
export { agentStreamingManifest } from './manifest';
export { agentStreamingManifest as AgentStreamingManifest } from './manifest';
