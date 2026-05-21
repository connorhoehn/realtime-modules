/**
 * AgentStream — concrete implementation of the AG-UI server emitter.
 *
 * One method per event. Each method:
 *   1. Runs lifecycle-state validation (dev-mode strict, prod log-and-continue).
 *   2. Builds the typed event object.
 *   3. Serialises to `data: <json>\n\n` and writes to the SSE sink.
 *
 * The sink is abstracted as a `StreamSink` so the class can be driven by
 * either an Express `Response` (via `createAgentStream`) or an in-memory
 * buffer (used by unit tests).
 */
import type { AgentStream as IAgentStream, AgUiRole, JsonPatchOp } from './types';
/** Minimal writable abstraction so AgentStream can target Express or a buffer. */
export interface StreamSink {
    /** Write a UTF-8 chunk. Returns false if the sink is back-pressured. */
    write(chunk: string): boolean;
    /** End the underlying transport (best-effort). */
    end?(): void;
    /** Subscribe to client-disconnect. Called at most once. */
    onClose(listener: () => void): void;
    /** True once the transport has been closed (by either side). */
    isClosed(): boolean;
}
export interface AgentStreamOptions {
    runId: string;
    threadId: string;
    /** Defaults to NODE_ENV !== 'production'. */
    devValidation?: boolean;
    /** Hook fired on the FIRST violation in prod (log-and-continue mode). */
    onValidationError?: (violation: string) => void;
    /** Optional client-disconnect hook (forwarded from the sink). */
    onClientDisconnect?: () => void;
    /** Override `Date.now` for tests. */
    now?: () => number;
}
export declare class AgentStreamImpl implements IAgentStream {
    readonly runId: string;
    readonly threadId: string;
    private readonly sink;
    private readonly devValidation;
    private readonly onValidationError?;
    private readonly now;
    private state;
    private _closed;
    constructor(sink: StreamSink, opts: AgentStreamOptions);
    get closed(): boolean;
    runStarted(opts: {
        runId: string;
        threadId: string;
        sessionId?: string;
        source?: string;
    }): void;
    runFinished(opts?: {
        outcome?: string;
        result?: unknown;
    }): void;
    runError(error: {
        message: string;
        code?: string;
    }): void;
    stepStarted(stepName: string): void;
    stepFinished(stepName: string): void;
    textMessageStart(messageId: string, role?: AgUiRole): void;
    textMessageContent(messageId: string, delta: string): void;
    textMessageEnd(messageId: string): void;
    textMessageChunk(opts?: {
        messageId?: string;
        role?: AgUiRole;
        delta?: string;
    }): void;
    toolCallStart(toolCallId: string, toolCallName: string, parentMessageId?: string): void;
    toolCallArgs(toolCallId: string, delta: string): void;
    toolCallEnd(toolCallId: string, result?: unknown): void;
    toolCallResult(messageId: string, toolCallId: string, content: unknown, role?: AgUiRole): void;
    toolCallChunk(opts?: {
        toolCallId?: string;
        toolCallName?: string;
        parentMessageId?: string;
        delta?: string;
    }): void;
    stateSnapshot(snapshot: unknown): void;
    stateDelta(patch: JsonPatchOp[]): void;
    messagesSnapshot(messages: unknown[]): void;
    activitySnapshot(opts: {
        messageId: string;
        activityType: string;
        content: unknown;
        replace?: boolean;
    }): void;
    activityDelta(opts: {
        messageId: string;
        activityType: string;
        patch: unknown;
    }): void;
    reasoningStart(messageId: string): void;
    reasoningContent(messageId: string, delta: string): void;
    reasoningEnd(messageId: string): void;
    reasoningChunk(messageId: string, delta?: string): void;
    reasoningSpanStart(messageId: string): void;
    reasoningSpanEnd(messageId: string): void;
    reasoningEncryptedValue(opts: {
        subtype: string;
        entityId: string;
        encryptedValue: string;
    }): void;
    custom(name: string, value: unknown): void;
    raw(event: unknown, source?: string): void;
    meta(metaType: string, payload: unknown): void;
    close(): void;
    /**
     * Run validator inside dev-mode strict / prod log-and-continue.
     * Returns `true` if the caller should proceed with the emit, `false`
     * if a violation was hit (and either thrown in dev, or recorded in
     * prod log-and-continue).
     */
    private guard;
    /** Throws in dev mode; in prod, logs + returns false so the emit is skipped. */
    private reportViolation;
    private requireRunStarted;
    private requireRunNotEnded;
    private emit;
}
export declare function validateJsonPatch(patch: unknown): void;
//# sourceMappingURL=AgentStream.d.ts.map