// Re-export the useAgentStream hook as a Lambda-friendly subpath
// that doesn't pull in Yjs-bound siblings from /client.
// Pairs with the server emitter exported from `./agent-streaming`.
export { useAgentStream } from '../client/useAgentStream';
export type {
  UseAgentStreamOptions,
  UseAgentStreamReturn,
  Message,
  ToolCall,
  BuildBody,
} from '../client/useAgentStream';
