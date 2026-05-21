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

import type {
  AgentStream as IAgentStream,
  AgUiEvent,
  AgUiRole,
  JsonPatchOp,
} from './types';

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

/** Per-event lifecycle state for dev-mode validation. */
interface LifecycleState {
  runStarted: boolean;
  runEnded: boolean;
  openTextMessages: Set<string>;
  openToolCalls: Set<string>;
  endedToolCalls: Set<string>;
  openReasoningMessages: Set<string>;
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

type Validator = () => void;

export class AgentStreamImpl implements IAgentStream {
  readonly runId: string;
  readonly threadId: string;

  private readonly sink: StreamSink;
  private readonly devValidation: boolean;
  private readonly onValidationError?: (violation: string) => void;
  private readonly now: () => number;

  private state: LifecycleState = {
    runStarted: false,
    runEnded: false,
    openTextMessages: new Set(),
    openToolCalls: new Set(),
    endedToolCalls: new Set(),
    openReasoningMessages: new Set(),
  };

  private _closed = false;

  constructor(sink: StreamSink, opts: AgentStreamOptions) {
    this.sink = sink;
    this.runId = opts.runId;
    this.threadId = opts.threadId;
    this.devValidation =
      opts.devValidation ?? process.env.NODE_ENV !== 'production';
    this.onValidationError = opts.onValidationError;
    this.now = opts.now ?? Date.now;

    this.sink.onClose(() => {
      this._closed = true;
      opts.onClientDisconnect?.();
    });
  }

  get closed(): boolean {
    return this._closed || this.sink.isClosed();
  }

  // --- Lifecycle ------------------------------------------------------------

  runStarted(opts: { runId: string; threadId: string; source?: string }): void {
    if (!this.guard('RUN_STARTED', () => {
      if (this.state.runStarted) throw new Error('runStarted: already started');
      if (this.state.runEnded) throw new Error('runStarted: run already ended');
    })) return;
    this.state.runStarted = true;
    const evt: AgUiEvent = opts.source
      ? {
          type: 'RUN_STARTED',
          threadId: opts.threadId,
          runId: opts.runId,
          rawEvent: { source: opts.source },
          timestamp: this.now(),
        }
      : {
          type: 'RUN_STARTED',
          threadId: opts.threadId,
          runId: opts.runId,
          timestamp: this.now(),
        };
    this.emit(evt);
  }

  runFinished(opts?: { outcome?: string; result?: unknown }): void {
    if (!this.guard('RUN_FINISHED', () => {
      this.requireRunStarted('runFinished');
      this.requireRunNotEnded('runFinished');
    })) return;
    this.state.runEnded = true;
    const evt: AgUiEvent = {
      type: 'RUN_FINISHED',
      ...(opts?.outcome !== undefined ? { outcome: opts.outcome } : {}),
      ...(opts?.result !== undefined ? { result: opts.result } : {}),
      timestamp: this.now(),
    };
    this.emit(evt);
  }

  runError(error: { message: string; code?: string }): void {
    if (!this.guard('RUN_ERROR', () => {
      this.requireRunNotEnded('runError');
    })) return;
    this.state.runEnded = true;
    const evt: AgUiEvent = {
      type: 'RUN_ERROR',
      message: error.message,
      ...(error.code !== undefined ? { code: error.code } : {}),
      timestamp: this.now(),
    };
    this.emit(evt);
  }

  stepStarted(stepName: string): void {
    if (!this.guard('STEP_STARTED', () => this.requireRunStarted('stepStarted'))) return;
    this.emit({ type: 'STEP_STARTED', stepName, timestamp: this.now() });
  }

  stepFinished(stepName: string): void {
    if (!this.guard('STEP_FINISHED', () => this.requireRunStarted('stepFinished'))) return;
    this.emit({ type: 'STEP_FINISHED', stepName, timestamp: this.now() });
  }

  // --- Text — verbose -------------------------------------------------------

  textMessageStart(messageId: string, role: AgUiRole = 'assistant'): void {
    if (!this.guard('TEXT_MESSAGE_START', () => {
      this.requireRunStarted('textMessageStart');
      if (this.state.openTextMessages.has(messageId)) {
        throw new Error(`textMessageStart: messageId ${messageId} is already open`);
      }
    })) return;
    this.state.openTextMessages.add(messageId);
    this.emit({
      type: 'TEXT_MESSAGE_START',
      messageId,
      role,
      timestamp: this.now(),
    });
  }

  textMessageContent(messageId: string, delta: string): void {
    if (!this.guard('TEXT_MESSAGE_CONTENT', () => {
      this.requireRunStarted('textMessageContent');
      if (!this.state.openTextMessages.has(messageId)) {
        throw new Error(`textMessageContent: no open message for messageId ${messageId}`);
      }
    })) return;
    this.emit({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId,
      delta,
      timestamp: this.now(),
    });
  }

  textMessageEnd(messageId: string): void {
    if (!this.guard('TEXT_MESSAGE_END', () => {
      this.requireRunStarted('textMessageEnd');
      if (!this.state.openTextMessages.has(messageId)) {
        throw new Error(`textMessageEnd: no open message for messageId ${messageId}`);
      }
    })) return;
    this.state.openTextMessages.delete(messageId);
    this.emit({ type: 'TEXT_MESSAGE_END', messageId, timestamp: this.now() });
  }

  textMessageChunk(opts: { messageId?: string; role?: AgUiRole; delta?: string } = {}): void {
    if (!this.guard('TEXT_MESSAGE_CHUNK', () => this.requireRunStarted('textMessageChunk'))) return;
    this.emit({ type: 'TEXT_MESSAGE_CHUNK', ...opts, timestamp: this.now() });
  }

  // --- Tool calls -----------------------------------------------------------

  toolCallStart(
    toolCallId: string,
    toolCallName: string,
    parentMessageId?: string,
  ): void {
    if (!this.guard('TOOL_CALL_START', () => {
      this.requireRunStarted('toolCallStart');
      if (this.state.openToolCalls.has(toolCallId)) {
        throw new Error(`toolCallStart: toolCallId ${toolCallId} is already open`);
      }
    })) return;
    this.state.openToolCalls.add(toolCallId);
    this.emit({
      type: 'TOOL_CALL_START',
      toolCallId,
      toolCallName,
      ...(parentMessageId !== undefined ? { parentMessageId } : {}),
      timestamp: this.now(),
    });
  }

  toolCallArgs(toolCallId: string, delta: string): void {
    if (!this.guard('TOOL_CALL_ARGS', () => {
      this.requireRunStarted('toolCallArgs');
      if (!this.state.openToolCalls.has(toolCallId)) {
        throw new Error(`toolCallArgs: no open tool call for toolCallId ${toolCallId}`);
      }
    })) return;
    this.emit({
      type: 'TOOL_CALL_ARGS',
      toolCallId,
      delta,
      timestamp: this.now(),
    });
  }

  toolCallEnd(toolCallId: string): void {
    if (!this.guard('TOOL_CALL_END', () => {
      this.requireRunStarted('toolCallEnd');
      if (!this.state.openToolCalls.has(toolCallId)) {
        throw new Error(`toolCallEnd: no open tool call for toolCallId ${toolCallId}`);
      }
    })) return;
    this.state.openToolCalls.delete(toolCallId);
    this.state.endedToolCalls.add(toolCallId);
    this.emit({ type: 'TOOL_CALL_END', toolCallId, timestamp: this.now() });
  }

  toolCallResult(
    messageId: string,
    toolCallId: string,
    content: unknown,
    role?: AgUiRole,
  ): void {
    if (!this.guard('TOOL_CALL_RESULT', () => {
      this.requireRunStarted('toolCallResult');
      // RESULT may legitimately arrive without a preceding END (some runtimes
      // emit result-only). Only reject the obvious case: still-open tool call.
      if (this.state.openToolCalls.has(toolCallId)) {
        throw new Error(`toolCallResult: toolCallId ${toolCallId} has not been ended yet`);
      }
    })) return;
    this.emit({
      type: 'TOOL_CALL_RESULT',
      messageId,
      toolCallId,
      content,
      ...(role !== undefined ? { role } : {}),
      timestamp: this.now(),
    });
  }

  toolCallChunk(opts: {
    toolCallId?: string;
    toolCallName?: string;
    parentMessageId?: string;
    delta?: string;
  } = {}): void {
    if (!this.guard('TOOL_CALL_CHUNK', () => this.requireRunStarted('toolCallChunk'))) return;
    this.emit({ type: 'TOOL_CALL_CHUNK', ...opts, timestamp: this.now() });
  }

  // --- State ----------------------------------------------------------------

  stateSnapshot(snapshot: unknown): void {
    if (!this.guard('STATE_SNAPSHOT', () => this.requireRunStarted('stateSnapshot'))) return;
    this.emit({ type: 'STATE_SNAPSHOT', snapshot, timestamp: this.now() });
  }

  stateDelta(patch: JsonPatchOp[]): void {
    if (!this.guard('STATE_DELTA', () => {
      this.requireRunStarted('stateDelta');
      validateJsonPatch(patch);
    })) return;
    this.emit({ type: 'STATE_DELTA', delta: patch, timestamp: this.now() });
  }

  messagesSnapshot(messages: unknown[]): void {
    if (!this.guard('MESSAGES_SNAPSHOT', () => this.requireRunStarted('messagesSnapshot'))) return;
    this.emit({ type: 'MESSAGES_SNAPSHOT', messages, timestamp: this.now() });
  }

  // --- Activity -------------------------------------------------------------

  activitySnapshot(opts: {
    messageId: string;
    activityType: string;
    content: unknown;
    replace?: boolean;
  }): void {
    if (!this.guard('ACTIVITY_SNAPSHOT', () => this.requireRunStarted('activitySnapshot'))) return;
    this.emit({
      type: 'ACTIVITY_SNAPSHOT',
      messageId: opts.messageId,
      activityType: opts.activityType,
      content: opts.content,
      ...(opts.replace !== undefined ? { replace: opts.replace } : {}),
      timestamp: this.now(),
    });
  }

  activityDelta(opts: {
    messageId: string;
    activityType: string;
    patch: unknown;
  }): void {
    if (!this.guard('ACTIVITY_DELTA', () => this.requireRunStarted('activityDelta'))) return;
    this.emit({
      type: 'ACTIVITY_DELTA',
      messageId: opts.messageId,
      activityType: opts.activityType,
      patch: opts.patch,
      timestamp: this.now(),
    });
  }

  // --- Reasoning ------------------------------------------------------------

  reasoningStart(messageId: string): void {
    if (!this.guard('REASONING_MESSAGE_START', () => {
      this.requireRunStarted('reasoningStart');
      if (this.state.openReasoningMessages.has(messageId)) {
        throw new Error(`reasoningStart: reasoning messageId ${messageId} is already open`);
      }
    })) return;
    this.state.openReasoningMessages.add(messageId);
    this.emit({
      type: 'REASONING_MESSAGE_START',
      messageId,
      role: 'reasoning',
      timestamp: this.now(),
    });
  }

  reasoningContent(messageId: string, delta: string): void {
    if (!this.guard('REASONING_MESSAGE_CONTENT', () => {
      this.requireRunStarted('reasoningContent');
      if (!this.state.openReasoningMessages.has(messageId)) {
        throw new Error(`reasoningContent: no open reasoning message for ${messageId}`);
      }
    })) return;
    this.emit({
      type: 'REASONING_MESSAGE_CONTENT',
      messageId,
      delta,
      timestamp: this.now(),
    });
  }

  reasoningEnd(messageId: string): void {
    if (!this.guard('REASONING_MESSAGE_END', () => {
      this.requireRunStarted('reasoningEnd');
      if (!this.state.openReasoningMessages.has(messageId)) {
        throw new Error(`reasoningEnd: no open reasoning message for ${messageId}`);
      }
    })) return;
    this.state.openReasoningMessages.delete(messageId);
    this.emit({
      type: 'REASONING_MESSAGE_END',
      messageId,
      timestamp: this.now(),
    });
  }

  reasoningChunk(messageId: string, delta?: string): void {
    if (!this.guard('REASONING_MESSAGE_CHUNK', () => this.requireRunStarted('reasoningChunk'))) return;
    this.emit({
      type: 'REASONING_MESSAGE_CHUNK',
      messageId,
      ...(delta !== undefined ? { delta } : {}),
      timestamp: this.now(),
    });
  }

  reasoningSpanStart(messageId: string): void {
    if (!this.guard('REASONING_START', () => this.requireRunStarted('reasoningSpanStart'))) return;
    this.emit({ type: 'REASONING_START', messageId, timestamp: this.now() });
  }

  reasoningSpanEnd(messageId: string): void {
    if (!this.guard('REASONING_END', () => this.requireRunStarted('reasoningSpanEnd'))) return;
    this.emit({ type: 'REASONING_END', messageId, timestamp: this.now() });
  }

  reasoningEncryptedValue(opts: {
    subtype: string;
    entityId: string;
    encryptedValue: string;
  }): void {
    if (!this.guard('REASONING_ENCRYPTED_VALUE', () => this.requireRunStarted('reasoningEncryptedValue'))) return;
    this.emit({
      type: 'REASONING_ENCRYPTED_VALUE',
      subtype: opts.subtype,
      entityId: opts.entityId,
      encryptedValue: opts.encryptedValue,
      timestamp: this.now(),
    });
  }

  // --- Extensions -----------------------------------------------------------

  custom(name: string, value: unknown): void {
    if (!this.guard('CUSTOM', () => this.requireRunStarted('custom'))) return;
    this.emit({ type: 'CUSTOM', name, value, timestamp: this.now() });
  }

  raw(event: unknown, source?: string): void {
    if (!this.guard('RAW', () => this.requireRunStarted('raw'))) return;
    this.emit({
      type: 'RAW',
      event,
      ...(source !== undefined ? { source } : {}),
      timestamp: this.now(),
    });
  }

  meta(metaType: string, payload: unknown): void {
    if (!this.guard('META_EVENT', () => this.requireRunStarted('meta'))) return;
    this.emit({ type: 'META_EVENT', metaType, payload, timestamp: this.now() });
  }

  // --- Bookkeeping ----------------------------------------------------------

  close(): void {
    if (this._closed) return;
    this._closed = true;
    try {
      this.sink.end?.();
    } catch {
      // Best-effort; underlying transport may already be torn down.
    }
  }

  // --- Internals ------------------------------------------------------------

  /**
   * Run validator inside dev-mode strict / prod log-and-continue.
   * Returns `true` if the caller should proceed with the emit, `false`
   * if a violation was hit (and either thrown in dev, or recorded in
   * prod log-and-continue).
   */
  private guard(eventName: string, validator: Validator): boolean {
    if (this._closed || this.sink.isClosed()) {
      // After close, all emits are no-ops by spec; treat as benign.
      return false;
    }
    if (this.state.runEnded && eventName !== 'RUN_FINISHED' && eventName !== 'RUN_ERROR') {
      return this.reportViolation(`${eventName}: run has already ended`);
    }
    try {
      validator();
      return true;
    } catch (err) {
      const violation = err instanceof Error ? err.message : String(err);
      return this.reportViolation(violation);
    }
  }

  /** Throws in dev mode; in prod, logs + returns false so the emit is skipped. */
  private reportViolation(violation: string): false {
    if (this.devValidation) {
      throw new Error(`[AgentStream] ${violation}`);
    }
    this.onValidationError?.(violation);
    return false;
  }

  private requireRunStarted(method: string): void {
    if (!this.state.runStarted) {
      throw new Error(`${method}: runStarted must be the first event`);
    }
  }

  private requireRunNotEnded(method: string): void {
    if (this.state.runEnded) {
      throw new Error(`${method}: run already ended`);
    }
  }

  private emit(event: AgUiEvent): void {
    if (this._closed || this.sink.isClosed()) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    this.sink.write(payload);
  }
}

// --- JSON Patch validation --------------------------------------------------

const PATCH_OPS = new Set(['add', 'replace', 'remove', 'move', 'copy', 'test']);

export function validateJsonPatch(patch: unknown): void {
  if (!Array.isArray(patch)) {
    throw new Error('stateDelta: patch must be an array of JSON Patch ops');
  }
  for (let i = 0; i < patch.length; i++) {
    const op = patch[i];
    if (!op || typeof op !== 'object') {
      throw new Error(`stateDelta: op[${i}] must be an object`);
    }
    const record = op as Record<string, unknown>;
    if (typeof record.op !== 'string' || !PATCH_OPS.has(record.op)) {
      throw new Error(
        `stateDelta: op[${i}].op must be one of add/replace/remove/move/copy/test`,
      );
    }
    if (typeof record.path !== 'string') {
      throw new Error(`stateDelta: op[${i}].path must be a string`);
    }
    if (record.op === 'move' || record.op === 'copy') {
      if (typeof record.from !== 'string') {
        throw new Error(
          `stateDelta: op[${i}].from must be a string for ${record.op}`,
        );
      }
    }
    if (record.op === 'add' || record.op === 'replace' || record.op === 'test') {
      if (!('value' in record)) {
        throw new Error(
          `stateDelta: op[${i}].value is required for ${record.op}`,
        );
      }
    }
  }
}
