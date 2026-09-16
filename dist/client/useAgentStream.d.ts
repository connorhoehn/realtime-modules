export interface ToolCall {
    id: string;
    name: string;
    args: string;
    result?: string;
    /** True once TOOL_CALL_END or CUSTOM `tool_call_result` has fired for this id. */
    done: boolean;
}
export interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    toolCalls?: ToolCall[];
}
/**
 * A named phase of the current agent run, surfaced from AG-UI
 * `STEP_STARTED` / `STEP_FINISHED` (`stepName`). Multi-agent runs can reuse
 * a step name (e.g. a retry), so entries are appended in the order seen
 * rather than keyed by name.
 */
export interface AgentStep {
    name: string;
    startedAt: number;
    finishedAt?: number;
    status: 'running' | 'done';
}
/**
 * Body builder — given the user-typed text plus the current sessionId (if any),
 * produce the JSON body to POST. Defaults to `{ message, sessionId? }`.
 */
export type BuildBody = (text: string, ctx: {
    sessionId: string | null;
}) => unknown;
export interface UseAgentStreamOptions {
    /** Endpoint to POST to, e.g. '/api/agents/search/invoke'. */
    url: string;
    /** Customize POST body shape. Default `{ message, sessionId? }`. */
    buildBody?: BuildBody;
    /** Additional headers (e.g. auth). `Content-Type` defaults to `application/json`. */
    headers?: HeadersInit;
    /** Injectable fetch for tests. Defaults to `globalThis.fetch`. */
    fetch?: typeof fetch;
    /**
     * History fetcher — if provided, `loadHistory(sessionId)` calls this and
     * stores the resulting messages. If omitted, `loadHistory` is a no-op that
     * only sets the sessionId (caller is responsible for any side effects).
     */
    historyFetch?: (sessionId: string) => Promise<Message[]>;
}
export interface UseAgentStreamReturn {
    messages: Message[];
    streamingText: string;
    activeToolCalls: ToolCall[];
    sessionId: string | null;
    isStreaming: boolean;
    error: string | null;
    /** Named phases of the current run, from STEP_STARTED / STEP_FINISHED. Reset on RUN_STARTED. */
    steps: AgentStep[];
    /** Chain-of-thought text accumulated from REASONING_* deltas. Reset on RUN_STARTED. */
    reasoning: string;
    sendMessage: (text: string) => Promise<void>;
    reset: () => void;
    loadHistory: (sessionId: string) => Promise<void>;
}
export declare function useAgentStream(opts: UseAgentStreamOptions): UseAgentStreamReturn;
//# sourceMappingURL=useAgentStream.d.ts.map