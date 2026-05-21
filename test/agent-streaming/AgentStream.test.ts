/**
 * Unit tests for AgentStreamImpl — verifies wire-shape per the AG-UI v0.1.x
 * client contract and the dev-mode lifecycle state machine.
 */

import {
  AgentStreamImpl,
  validateJsonPatch,
  type StreamSink,
} from '../../src/agent-streaming/AgentStream';

/** Capture every SSE frame written to the sink so tests can assert on shape. */
class BufferSink implements StreamSink {
  public frames: string[] = [];
  public events: Record<string, unknown>[] = [];
  public ended = false;
  public closeListeners: Array<() => void> = [];

  write(chunk: string): boolean {
    this.frames.push(chunk);
    if (chunk.startsWith('data: ')) {
      const body = chunk.slice('data: '.length, -'\n\n'.length);
      this.events.push(JSON.parse(body) as Record<string, unknown>);
    }
    return true;
  }
  end(): void {
    this.ended = true;
    for (const l of this.closeListeners) l();
  }
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }
  isClosed(): boolean {
    return this.ended;
  }
}

function makeStream(sink = new BufferSink(), opts: { devValidation?: boolean } = {}) {
  const stream = new AgentStreamImpl(sink, {
    runId: 'r-1',
    threadId: 't-1',
    devValidation: opts.devValidation ?? true,
    now: () => 1234,
  });
  return { stream, sink };
}

describe('AgentStreamImpl — SSE serialization', () => {
  it('frames each event as `data: <json>\\n\\n`', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });

    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0]!.startsWith('data: ')).toBe(true);
    expect(sink.frames[0]!.endsWith('\n\n')).toBe(true);
    expect(sink.events[0]).toMatchObject({
      type: 'RUN_STARTED',
      runId: 'r-1',
      threadId: 't-1',
      timestamp: 1234,
    });
  });

  it('emits one frame per method call', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.textMessageStart('m-1');
    stream.textMessageContent('m-1', 'hi');
    stream.textMessageEnd('m-1');
    stream.runFinished();

    expect(sink.events.map((e) => e.type)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ]);
  });
});

describe('AgentStreamImpl — lifecycle events', () => {
  it('runStarted emits required threadId + runId', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'run-a', threadId: 'thread-a' });
    expect(sink.events[0]).toMatchObject({
      type: 'RUN_STARTED',
      runId: 'run-a',
      threadId: 'thread-a',
    });
  });

  it('runFinished accepts outcome + result', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.runFinished({ outcome: 'ok', result: { a: 1 } });
    expect(sink.events[1]).toMatchObject({
      type: 'RUN_FINISHED',
      outcome: 'ok',
      result: { a: 1 },
    });
  });

  it('runError uses `message`, NOT `error` (field-name regression)', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.runError({ message: 'boom', code: 'E_FAIL' });
    const evt = sink.events[1]!;
    expect(evt.type).toBe('RUN_ERROR');
    expect(evt.message).toBe('boom');
    expect(evt.code).toBe('E_FAIL');
    expect((evt as Record<string, unknown>).error).toBeUndefined();
  });

  it('stepStarted + stepFinished emit stepName', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.stepStarted('plan');
    stream.stepFinished('plan');
    expect(sink.events[1]).toMatchObject({ type: 'STEP_STARTED', stepName: 'plan' });
    expect(sink.events[2]).toMatchObject({ type: 'STEP_FINISHED', stepName: 'plan' });
  });
});

describe('AgentStreamImpl — text messages', () => {
  it('textMessageStart defaults role to "assistant"', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.textMessageStart('m-1');
    expect(sink.events[1]).toMatchObject({
      type: 'TEXT_MESSAGE_START',
      messageId: 'm-1',
      role: 'assistant',
    });
  });

  it('textMessageContent uses `delta` field', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.textMessageStart('m-1');
    stream.textMessageContent('m-1', 'Hello');
    stream.textMessageContent('m-1', ' world');
    expect(sink.events[2]).toMatchObject({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'm-1',
      delta: 'Hello',
    });
    expect(sink.events[3]!.delta).toBe(' world');
  });

  it('textMessageChunk allows fully-empty payload (compact form)', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.textMessageChunk({ messageId: 'm-1', delta: 'x' });
    expect(sink.events[1]).toMatchObject({
      type: 'TEXT_MESSAGE_CHUNK',
      messageId: 'm-1',
      delta: 'x',
    });
  });
});

describe('AgentStreamImpl — tool call field-name regression guards', () => {
  it('TOOL_CALL_START serializes `toolCallName` (NOT toolName / name)', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.toolCallStart('tc-1', 'search', 'm-1');

    const evt = sink.events[1]!;
    expect(evt.type).toBe('TOOL_CALL_START');
    expect(evt.toolCallId).toBe('tc-1');
    expect(evt.toolCallName).toBe('search');
    expect(evt.parentMessageId).toBe('m-1');
    // These would be the bug-flagged regressions — must NOT appear.
    expect((evt as Record<string, unknown>).toolName).toBeUndefined();
    expect((evt as Record<string, unknown>).name).toBeUndefined();
  });

  it('TOOL_CALL_ARGS serializes `delta` (NOT args)', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.toolCallStart('tc-1', 'search');
    stream.toolCallArgs('tc-1', '{"q":"hello"}');

    const evt = sink.events[2]!;
    expect(evt.type).toBe('TOOL_CALL_ARGS');
    expect(evt.delta).toBe('{"q":"hello"}');
    expect((evt as Record<string, unknown>).args).toBeUndefined();
  });

  it('TOOL_CALL_RESULT is a separate event with messageId + content (NOT inlined on END)', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.toolCallStart('tc-1', 'search', 'm-1');
    stream.toolCallArgs('tc-1', '{}');
    stream.toolCallEnd('tc-1');
    stream.toolCallResult('m-1', 'tc-1', { rows: [1, 2, 3] });

    const endEvt = sink.events[3]!;
    expect(endEvt.type).toBe('TOOL_CALL_END');
    // END must NOT carry the result.
    expect((endEvt as Record<string, unknown>).content).toBeUndefined();
    expect((endEvt as Record<string, unknown>).result).toBeUndefined();

    const resultEvt = sink.events[4]!;
    expect(resultEvt.type).toBe('TOOL_CALL_RESULT');
    expect(resultEvt.messageId).toBe('m-1');
    expect(resultEvt.toolCallId).toBe('tc-1');
    expect(resultEvt.content).toEqual({ rows: [1, 2, 3] });
    expect((resultEvt as Record<string, unknown>).result).toBeUndefined();
  });

  it('toolCallStart omits parentMessageId when not supplied', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.toolCallStart('tc-1', 'search');
    expect(sink.events[1]).not.toHaveProperty('parentMessageId');
  });
});

describe('AgentStreamImpl — state events', () => {
  it('stateSnapshot replaces state', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.stateSnapshot({ counter: 0 });
    expect(sink.events[1]).toMatchObject({
      type: 'STATE_SNAPSHOT',
      snapshot: { counter: 0 },
    });
  });

  it('stateDelta serializes JSON Patch as `delta` field', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.stateDelta([{ op: 'add', path: '/counter', value: 1 }]);
    expect(sink.events[1]).toMatchObject({
      type: 'STATE_DELTA',
      delta: [{ op: 'add', path: '/counter', value: 1 }],
    });
  });

  it('messagesSnapshot bulk-replaces the messages array', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.messagesSnapshot([{ id: 'm-1' }]);
    expect(sink.events[1]).toMatchObject({
      type: 'MESSAGES_SNAPSHOT',
      messages: [{ id: 'm-1' }],
    });
  });
});

describe('AgentStreamImpl — reasoning events', () => {
  it('REASONING_MESSAGE_START enforces role=reasoning', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.reasoningStart('m-1');
    expect(sink.events[1]).toMatchObject({
      type: 'REASONING_MESSAGE_START',
      messageId: 'm-1',
      role: 'reasoning',
    });
  });

  it('REASONING_MESSAGE_CONTENT carries delta', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.reasoningStart('m-1');
    stream.reasoningContent('m-1', 'thinking...');
    expect(sink.events[2]).toMatchObject({
      type: 'REASONING_MESSAGE_CONTENT',
      messageId: 'm-1',
      delta: 'thinking...',
    });
  });

  it('reasoning lifecycle: start → content → end → chunk', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.reasoningStart('r-msg-1');
    stream.reasoningContent('r-msg-1', 'a');
    stream.reasoningEnd('r-msg-1');
    stream.reasoningChunk('r-msg-2', 'compact');
    expect(sink.events.map((e) => e.type)).toEqual([
      'RUN_STARTED',
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END',
      'REASONING_MESSAGE_CHUNK',
    ]);
  });

  it('reasoningEncryptedValue forwards subtype + entityId + value', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.reasoningEncryptedValue({
      subtype: 'cot',
      entityId: 'e-1',
      encryptedValue: 'cipher',
    });
    expect(sink.events[1]).toMatchObject({
      type: 'REASONING_ENCRYPTED_VALUE',
      subtype: 'cot',
      entityId: 'e-1',
      encryptedValue: 'cipher',
    });
  });
});

describe('AgentStreamImpl — activity + extension events', () => {
  it('activitySnapshot carries messageId + activityType + content', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.activitySnapshot({
      messageId: 'm-1',
      activityType: 'thinking',
      content: 'foo',
      replace: true,
    });
    expect(sink.events[1]).toMatchObject({
      type: 'ACTIVITY_SNAPSHOT',
      messageId: 'm-1',
      activityType: 'thinking',
      content: 'foo',
      replace: true,
    });
  });

  it('activityDelta carries the patch payload', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.activityDelta({ messageId: 'm-1', activityType: 'x', patch: { a: 1 } });
    expect(sink.events[1]).toMatchObject({
      type: 'ACTIVITY_DELTA',
      patch: { a: 1 },
    });
  });

  it('custom uses `name` + `value` fields', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.custom('agent.cost', { tokens: 42 });
    expect(sink.events[1]).toMatchObject({
      type: 'CUSTOM',
      name: 'agent.cost',
      value: { tokens: 42 },
    });
  });

  it('raw + meta serialize as expected', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.raw({ a: 1 }, 'bedrock');
    stream.meta('progress', { pct: 50 });
    expect(sink.events[1]).toMatchObject({
      type: 'RAW',
      event: { a: 1 },
      source: 'bedrock',
    });
    expect(sink.events[2]).toMatchObject({
      type: 'META_EVENT',
      metaType: 'progress',
      payload: { pct: 50 },
    });
  });
});

describe('AgentStreamImpl — dev-mode lifecycle validation', () => {
  it('throws when textMessageContent is called before textMessageStart', () => {
    const { stream } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    expect(() => stream.textMessageContent('m-1', 'hi')).toThrow(
      /no open message/,
    );
  });

  it('throws when toolCallArgs is called without preceding toolCallStart', () => {
    const { stream } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    expect(() => stream.toolCallArgs('tc-1', '{}')).toThrow(/no open tool call/);
  });

  it('throws when toolCallEnd is called without preceding toolCallStart', () => {
    const { stream } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    expect(() => stream.toolCallEnd('tc-1')).toThrow(/no open tool call/);
  });

  it('throws when runStarted is not the first event', () => {
    const { stream } = makeStream();
    expect(() => stream.textMessageStart('m-1')).toThrow(/runStarted must be the first/);
  });

  it('throws when runStarted is called twice', () => {
    const { stream } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    expect(() => stream.runStarted({ runId: 'r-2', threadId: 't-2' })).toThrow(
      /already started/,
    );
  });

  it('throws when both runFinished and runError are fired', () => {
    const { stream } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.runFinished();
    expect(() => stream.runError({ message: 'late' })).toThrow(/already ended/);
  });

  it('drops emits after runFinished (log-and-continue in prod mode)', () => {
    const sink = new BufferSink();
    const violations: string[] = [];
    const stream = new AgentStreamImpl(sink, {
      runId: 'r-1',
      threadId: 't-1',
      devValidation: false,
      onValidationError: (v) => violations.push(v),
    });
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.runFinished();
    stream.textMessageStart('m-1'); // should drop, not throw
    expect(sink.events.map((e) => e.type)).toEqual(['RUN_STARTED', 'RUN_FINISHED']);
    expect(violations).toEqual([
      expect.stringContaining('TEXT_MESSAGE_START: run has already ended'),
    ]);
  });

  it('toolCallResult before END throws (still-open tool call)', () => {
    const { stream } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.toolCallStart('tc-1', 'search');
    expect(() => stream.toolCallResult('m-1', 'tc-1', 'x')).toThrow(/not been ended/);
  });

  it('toolCallResult AFTER END succeeds', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.toolCallStart('tc-1', 'search');
    stream.toolCallEnd('tc-1');
    stream.toolCallResult('m-1', 'tc-1', 'ok');
    expect(sink.events[3]!.type).toBe('TOOL_CALL_RESULT');
  });
});

describe('AgentStreamImpl — close + sink-disconnect semantics', () => {
  it('close() makes future emits a no-op without throwing', () => {
    const { stream, sink } = makeStream();
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    stream.close();
    expect(stream.closed).toBe(true);
    // After close, all guards return early — must not throw.
    expect(() => stream.textMessageStart('m-1')).not.toThrow();
    expect(sink.events).toHaveLength(1);
  });

  it('sink-side close propagates to stream.closed', () => {
    const sink = new BufferSink();
    const stream = new AgentStreamImpl(sink, {
      runId: 'r-1',
      threadId: 't-1',
      devValidation: false,
    });
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    sink.end();
    expect(stream.closed).toBe(true);
  });

  it('onClientDisconnect fires when sink closes', () => {
    const sink = new BufferSink();
    let called = 0;
    const stream = new AgentStreamImpl(sink, {
      runId: 'r-1',
      threadId: 't-1',
      devValidation: false,
      onClientDisconnect: () => called++,
    });
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    sink.end();
    expect(called).toBe(1);
  });
});

describe('validateJsonPatch', () => {
  it('accepts a well-formed patch', () => {
    expect(() =>
      validateJsonPatch([
        { op: 'add', path: '/a', value: 1 },
        { op: 'replace', path: '/b', value: 2 },
        { op: 'remove', path: '/c' },
        { op: 'move', from: '/x', path: '/y' },
        { op: 'copy', from: '/p', path: '/q' },
        { op: 'test', path: '/t', value: 'x' },
      ]),
    ).not.toThrow();
  });

  it('rejects non-array input', () => {
    expect(() => validateJsonPatch({} as unknown)).toThrow(/must be an array/);
  });

  it('rejects unknown op', () => {
    expect(() =>
      validateJsonPatch([{ op: 'mutate', path: '/x', value: 1 } as unknown]),
    ).toThrow(/must be one of/);
  });

  it('rejects missing path', () => {
    expect(() =>
      validateJsonPatch([{ op: 'add', value: 1 } as unknown]),
    ).toThrow(/path must be a string/);
  });

  it('rejects move without `from`', () => {
    expect(() =>
      validateJsonPatch([{ op: 'move', path: '/y' } as unknown]),
    ).toThrow(/from must be a string/);
  });

  it('rejects add without `value`', () => {
    expect(() =>
      validateJsonPatch([{ op: 'add', path: '/x' } as unknown]),
    ).toThrow(/value is required/);
  });
});
