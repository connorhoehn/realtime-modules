/**
 * AG-UI v0.1.x protocol event types — server emitter contract.
 *
 * Mirrors the 28 event-type catalog documented in
 * `ui-components/src/components/agents/README.md`. Field names match the
 * AG-UI spec exactly; the type system enforces the three regressions the
 * design spec flags:
 *
 *   1. TOOL_CALL_START.toolCallName   (NOT toolName, NOT name)
 *   2. TOOL_CALL_ARGS.delta           (NOT args)
 *   3. TOOL_CALL_RESULT is a separate event AFTER TOOL_CALL_END with
 *      messageId + content (NOT inlined on TOOL_CALL_END)
 *   4. RUN_ERROR.message              (NOT error)
 *   5. STATE_DELTA.delta is a JsonPatchOp[] (RFC 6902)
 */
export type JsonPatchOp = {
    op: 'add';
    path: string;
    value: unknown;
} | {
    op: 'replace';
    path: string;
    value: unknown;
} | {
    op: 'remove';
    path: string;
} | {
    op: 'move';
    from: string;
    path: string;
} | {
    op: 'copy';
    from: string;
    path: string;
} | {
    op: 'test';
    path: string;
    value: unknown;
};
export type AgUiEventType = 'RUN_STARTED' | 'RUN_FINISHED' | 'RUN_ERROR' | 'STEP_STARTED' | 'STEP_FINISHED' | 'TEXT_MESSAGE_START' | 'TEXT_MESSAGE_CONTENT' | 'TEXT_MESSAGE_END' | 'TEXT_MESSAGE_CHUNK' | 'TOOL_CALL_START' | 'TOOL_CALL_ARGS' | 'TOOL_CALL_END' | 'TOOL_CALL_RESULT' | 'TOOL_CALL_CHUNK' | 'STATE_SNAPSHOT' | 'STATE_DELTA' | 'MESSAGES_SNAPSHOT' | 'ACTIVITY_SNAPSHOT' | 'ACTIVITY_DELTA' | 'REASONING_MESSAGE_START' | 'REASONING_MESSAGE_CONTENT' | 'REASONING_MESSAGE_END' | 'REASONING_MESSAGE_CHUNK' | 'REASONING_START' | 'REASONING_END' | 'REASONING_ENCRYPTED_VALUE' | 'CUSTOM' | 'RAW' | 'META_EVENT';
interface BaseEvent {
    timestamp?: number;
    rawEvent?: unknown;
}
export interface RunStartedEvent extends BaseEvent {
    type: 'RUN_STARTED';
    threadId: string;
    runId: string;
    parentRunId?: string;
    /**
     * Application-level session identifier. Not part of the AG-UI v0.1.x core
     * spec (which only mandates runId/threadId), but widely needed by consumers
     * (e.g. OrgIQ) to correlate the run with a persistent chat session.
     * Normalised here so consumers don't need a custom CUSTOM `session` event.
     */
    sessionId?: string;
    input?: unknown;
}
export interface RunFinishedEvent extends BaseEvent {
    type: 'RUN_FINISHED';
    outcome?: string;
    result?: unknown;
}
export interface RunErrorEvent extends BaseEvent {
    type: 'RUN_ERROR';
    message: string;
    code?: string;
}
export interface StepStartedEvent extends BaseEvent {
    type: 'STEP_STARTED';
    stepName: string;
}
export interface StepFinishedEvent extends BaseEvent {
    type: 'STEP_FINISHED';
    stepName: string;
}
export type AgUiRole = 'assistant' | 'system' | 'user' | 'tool';
export interface TextMessageStartEvent extends BaseEvent {
    type: 'TEXT_MESSAGE_START';
    messageId: string;
    role: AgUiRole;
}
export interface TextMessageContentEvent extends BaseEvent {
    type: 'TEXT_MESSAGE_CONTENT';
    messageId: string;
    delta: string;
}
export interface TextMessageEndEvent extends BaseEvent {
    type: 'TEXT_MESSAGE_END';
    messageId: string;
}
export interface TextMessageChunkEvent extends BaseEvent {
    type: 'TEXT_MESSAGE_CHUNK';
    messageId?: string;
    role?: AgUiRole;
    delta?: string;
}
export interface ToolCallStartEvent extends BaseEvent {
    type: 'TOOL_CALL_START';
    toolCallId: string;
    /** Must be `toolCallName` — not `toolName` and not `name`. */
    toolCallName: string;
    parentMessageId?: string;
}
export interface ToolCallArgsEvent extends BaseEvent {
    type: 'TOOL_CALL_ARGS';
    toolCallId: string;
    /** Must be `delta` — not `args`. Multiple deltas concatenate client-side. */
    delta: string;
}
export interface ToolCallEndEvent extends BaseEvent {
    type: 'TOOL_CALL_END';
    toolCallId: string;
    /**
     * Optional inline result payload. Not in the AG-UI v0.1.x core spec (which
     * prescribes a separate TOOL_CALL_RESULT event), but accepted here as a
     * convenience shorthand for runtimes that emit a single end+result frame.
     * The hook normalises this the same way it handles a TOOL_CALL_RESULT.
     */
    result?: unknown;
}
export interface ToolCallResultEvent extends BaseEvent {
    type: 'TOOL_CALL_RESULT';
    /** AG-UI spec requires both messageId and toolCallId on RESULT. */
    messageId: string;
    toolCallId: string;
    /** Result payload — serialised as JSON; field is `content`, not `result`. */
    content: unknown;
    role?: AgUiRole;
}
export interface ToolCallChunkEvent extends BaseEvent {
    type: 'TOOL_CALL_CHUNK';
    toolCallId?: string;
    toolCallName?: string;
    parentMessageId?: string;
    delta?: string;
}
export interface StateSnapshotEvent extends BaseEvent {
    type: 'STATE_SNAPSHOT';
    snapshot: unknown;
}
export interface StateDeltaEvent extends BaseEvent {
    type: 'STATE_DELTA';
    /** RFC 6902 patch list. */
    delta: JsonPatchOp[];
}
export interface MessagesSnapshotEvent extends BaseEvent {
    type: 'MESSAGES_SNAPSHOT';
    messages: unknown[];
}
export interface ActivitySnapshotEvent extends BaseEvent {
    type: 'ACTIVITY_SNAPSHOT';
    messageId: string;
    activityType: string;
    content: unknown;
    replace?: boolean;
}
export interface ActivityDeltaEvent extends BaseEvent {
    type: 'ACTIVITY_DELTA';
    messageId: string;
    activityType: string;
    patch: unknown;
}
export interface ReasoningMessageStartEvent extends BaseEvent {
    type: 'REASONING_MESSAGE_START';
    messageId: string;
    role: 'reasoning';
}
export interface ReasoningMessageContentEvent extends BaseEvent {
    type: 'REASONING_MESSAGE_CONTENT';
    messageId: string;
    delta: string;
}
export interface ReasoningMessageEndEvent extends BaseEvent {
    type: 'REASONING_MESSAGE_END';
    messageId: string;
}
export interface ReasoningMessageChunkEvent extends BaseEvent {
    type: 'REASONING_MESSAGE_CHUNK';
    messageId: string;
    delta?: string;
}
export interface ReasoningStartEvent extends BaseEvent {
    type: 'REASONING_START';
    messageId: string;
}
export interface ReasoningEndEvent extends BaseEvent {
    type: 'REASONING_END';
    messageId: string;
}
export interface ReasoningEncryptedValueEvent extends BaseEvent {
    type: 'REASONING_ENCRYPTED_VALUE';
    subtype: string;
    entityId: string;
    encryptedValue: string;
}
export interface CustomEvent extends BaseEvent {
    type: 'CUSTOM';
    name: string;
    value: unknown;
}
export interface RawEvent extends BaseEvent {
    type: 'RAW';
    event: unknown;
    source?: string;
}
export interface MetaEvent extends BaseEvent {
    type: 'META_EVENT';
    metaType: string;
    payload: unknown;
}
export type AgUiEvent = RunStartedEvent | RunFinishedEvent | RunErrorEvent | StepStartedEvent | StepFinishedEvent | TextMessageStartEvent | TextMessageContentEvent | TextMessageEndEvent | TextMessageChunkEvent | ToolCallStartEvent | ToolCallArgsEvent | ToolCallEndEvent | ToolCallResultEvent | ToolCallChunkEvent | StateSnapshotEvent | StateDeltaEvent | MessagesSnapshotEvent | ActivitySnapshotEvent | ActivityDeltaEvent | ReasoningMessageStartEvent | ReasoningMessageContentEvent | ReasoningMessageEndEvent | ReasoningMessageChunkEvent | ReasoningStartEvent | ReasoningEndEvent | ReasoningEncryptedValueEvent | CustomEvent | RawEvent | MetaEvent;
/**
 * Server-side AG-UI event emitter. Each method produces exactly one SSE
 * `data:` frame on the wire. Field names are pinned by the type system to
 * match the v0.1.x client contract.
 */
export interface AgentStream {
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
    readonly runId: string;
    readonly threadId: string;
    readonly closed: boolean;
    close(): void;
}
export {};
//# sourceMappingURL=types.d.ts.map