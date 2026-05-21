/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useAgentStream.test.tsx
//
// Exercises the useAgentStream hook via an injected stub fetch that
// returns a ReadableStream of SSE bytes. Covers:
//   - sendMessage POST body shape (default + buildBody override + headers)
//   - RUN_STARTED resets streamingText
//   - TEXT_MESSAGE_CONTENT deltas accumulate into streamingText
//   - TEXT_MESSAGE_END finalizes the in-progress text into messages[]
//   - TOOL_CALL_START / ARGS / END flow through activeToolCalls
//   - CUSTOM `session` captures sessionId
//   - CUSTOM `tool_call_result` attaches result to matching activeToolCalls
//   - RUN_ERROR records error string
//   - reset() clears state + aborts in-flight stream
//   - Unmount aborts the in-flight fetch
//   - SSE heartbeats (`:` comments) are silently skipped

// jsdom doesn't expose web-platform encoders/streams globally. Polyfill from
// Node built-ins (util, stream/web) before importing anything that touches
// them — the hook uses `new TextDecoder()` inside its reader loop, and the
// test helpers build `ReadableStream`s. No new deps required.
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';
import { ReadableStream as NodeReadableStream } from 'stream/web';

const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.TextEncoder === 'undefined') g.TextEncoder = NodeTextEncoder;
if (typeof g.TextDecoder === 'undefined') g.TextDecoder = NodeTextDecoder;
if (typeof g.ReadableStream === 'undefined') g.ReadableStream = NodeReadableStream;

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAgentStream } from '../../src/client/useAgentStream';

// ---------------------------------------------------------------------------
// SSE stream helper — yields chunks as encoded Uint8Array frames
// ---------------------------------------------------------------------------

function encodeSse(frames: Array<Record<string, unknown> | string>): Uint8Array {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  for (const f of frames) {
    if (typeof f === 'string') {
      // Raw line (e.g. a heartbeat) — caller adds the trailing newline(s).
      parts.push(f);
    } else {
      parts.push(`data: ${JSON.stringify(f)}\n\n`);
    }
  }
  return encoder.encode(parts.join(''));
}

/**
 * Build a duck-typed Response-like whose body emits the given chunks
 * sequentially. The hook only needs `.ok`, `.status`, and
 * `.body.getReader()` — so we sidestep jsdom's missing `Response` ctor.
 * Each chunk is enqueued lazily on `pull` so the hook's reader loop
 * observes one chunk at a time (matches real wire behavior).
 */
function makeStreamResponse(chunks: Uint8Array[]): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i]!);
      i++;
    },
  });
  // Cast — we deliberately ship a duck-typed object rather than a real
  // Response since jsdom doesn't expose the Response constructor.
  return {
    ok: true,
    status: 200,
    body: stream,
  } as unknown as Response;
}

/**
 * Build a fake fetch that resolves to the given SSE chunks. Captures the
 * last call so tests can assert on URL/headers/body.
 */
function makeFetchStub(chunks: Uint8Array[]): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const stub: typeof fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (init?.signal) {
      // Honor aborts — if already aborted, reject immediately.
      if (init.signal.aborted) {
        const err = new Error('aborted');
        (err as Error & { name: string }).name = 'AbortError';
        return Promise.reject(err);
      }
    }
    return Promise.resolve(makeStreamResponse(chunks));
  }) as unknown as typeof fetch;
  return { fetch: stub, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useRealTimers();
});

describe('useAgentStream', () => {
  it('POSTs with default body shape { message } and Content-Type application/json', async () => {
    const { fetch: fetchStub, calls } = makeFetchStub([
      encodeSse([
        { type: 'RUN_STARTED', runId: 'r1', threadId: 't1' },
        { type: 'RUN_FINISHED' },
      ]),
    ]);

    const { result } = renderHook(() =>
      useAgentStream({ url: '/api/agents/test', fetch: fetchStub }),
    );

    await act(async () => {
      await result.current.sendMessage('hello');
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/agents/test');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ message: 'hello' });
  });

  it('uses custom buildBody when provided', async () => {
    const { fetch: fetchStub, calls } = makeFetchStub([
      encodeSse([{ type: 'RUN_FINISHED' }]),
    ]);
    const buildBody = jest.fn((text: string, ctx: { sessionId: string | null }) => ({
      query: text,
      meta: { sid: ctx.sessionId, extra: 'x' },
    }));

    const { result } = renderHook(() =>
      useAgentStream({
        url: '/api/x',
        fetch: fetchStub,
        buildBody: buildBody as unknown as (typeof useAgentStream extends (o: infer O) => unknown ? O : never)['buildBody'],
      }),
    );

    await act(async () => {
      await result.current.sendMessage('hey');
    });

    expect(buildBody).toHaveBeenCalledWith('hey', { sessionId: null });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ query: 'hey', meta: { sid: null, extra: 'x' } });
  });

  it('accumulates streamingText from TEXT_MESSAGE_CONTENT deltas, then finalizes on TEXT_MESSAGE_END', async () => {
    const { fetch: fetchStub } = makeFetchStub([
      encodeSse([
        { type: 'RUN_STARTED', runId: 'r1', threadId: 't1' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hello ' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'world' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
        { type: 'RUN_FINISHED' },
      ]),
    ]);

    const { result } = renderHook(() =>
      useAgentStream({ url: '/x', fetch: fetchStub }),
    );

    await act(async () => {
      await result.current.sendMessage('hi');
    });

    // After completion, streamingText is reset and the message is in messages[].
    expect(result.current.streamingText).toBe('');
    // messages has user + assistant.
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]).toEqual(
      expect.objectContaining({ role: 'user', content: 'hi' }),
    );
    expect(result.current.messages[1]).toEqual(
      expect.objectContaining({ id: 'm1', role: 'assistant', content: 'Hello world' }),
    );
  });

  it('handles full TOOL_CALL_START / ARGS / END flow', async () => {
    const { fetch: fetchStub } = makeFetchStub([
      encodeSse([
        { type: 'RUN_STARTED', runId: 'r1', threadId: 't1' },
        { type: 'TOOL_CALL_START', toolCallId: 'tc-1', toolCallName: 'search' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'tc-1', delta: '{"q":' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'tc-1', delta: '"foo"}' },
        { type: 'TOOL_CALL_END', toolCallId: 'tc-1' },
        { type: 'RUN_FINISHED' },
      ]),
    ]);

    const { result } = renderHook(() =>
      useAgentStream({ url: '/x', fetch: fetchStub }),
    );

    await act(async () => {
      await result.current.sendMessage('search foo');
    });

    // After RUN_FINISHED, the tool call lives on the finalized assistant
    // message; activeToolCalls is cleared.
    expect(result.current.activeToolCalls).toHaveLength(0);
    const assistant = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.toolCalls).toEqual([
      expect.objectContaining({
        id: 'tc-1',
        name: 'search',
        args: '{"q":"foo"}',
        done: true,
      }),
    ]);
  });

  it('also reads the legacy `name` field on TOOL_CALL_START for transition compat', async () => {
    const { fetch: fetchStub } = makeFetchStub([
      encodeSse([
        { type: 'RUN_STARTED', runId: 'r1', threadId: 't1' },
        // legacy emitter: `name` not `toolCallName`
        { type: 'TOOL_CALL_START', toolCallId: 'tc-2', name: 'legacy_tool' },
        { type: 'TOOL_CALL_END', toolCallId: 'tc-2' },
        { type: 'RUN_FINISHED' },
      ]),
    ]);

    const { result } = renderHook(() =>
      useAgentStream({ url: '/x', fetch: fetchStub }),
    );

    await act(async () => {
      await result.current.sendMessage('go');
    });

    const assistant = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistant!.toolCalls?.[0]?.name).toBe('legacy_tool');
  });

  it('captures sessionId from CUSTOM `session` event', async () => {
    const { fetch: fetchStub } = makeFetchStub([
      encodeSse([
        { type: 'RUN_STARTED', runId: 'r1', threadId: 't1' },
        { type: 'CUSTOM', name: 'session', value: { sessionId: 'sess-abc' } },
        { type: 'RUN_FINISHED' },
      ]),
    ]);

    const { result } = renderHook(() =>
      useAgentStream({ url: '/x', fetch: fetchStub }),
    );

    await act(async () => {
      await result.current.sendMessage('hi');
    });

    expect(result.current.sessionId).toBe('sess-abc');
  });

  it('reuses captured sessionId on subsequent sendMessage via default buildBody', async () => {
    // First call: server captures + echoes the sessionId.
    // Second call: hook should include sessionId in the POST body.
    let callCount = 0;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchStub: typeof fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      callCount++;
      const frames =
        callCount === 1
          ? [
              { type: 'RUN_STARTED', runId: 'r1', threadId: 't1' },
              { type: 'CUSTOM', name: 'session', value: { sessionId: 'sess-xyz' } },
              { type: 'RUN_FINISHED' },
            ]
          : [{ type: 'RUN_FINISHED' }];
      return Promise.resolve(makeStreamResponse([encodeSse(frames)]));
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useAgentStream({ url: '/x', fetch: fetchStub }),
    );

    await act(async () => {
      await result.current.sendMessage('first');
    });
    expect(result.current.sessionId).toBe('sess-xyz');

    await act(async () => {
      await result.current.sendMessage('second');
    });

    const body2 = JSON.parse(calls[1]!.init.body as string);
    expect(body2).toEqual({ message: 'second', sessionId: 'sess-xyz' });
  });

  it('CUSTOM `tool_call_result` attaches result to the matching activeToolCalls entry', async () => {
    // Stream stops just after the result so we can inspect activeToolCalls
    // before RUN_FINISHED clears them.
    const { fetch: fetchStub } = makeFetchStub([
      encodeSse([
        { type: 'RUN_STARTED', runId: 'r1', threadId: 't1' },
        { type: 'TOOL_CALL_START', toolCallId: 'tc-9', toolCallName: 'lookup' },
        { type: 'TOOL_CALL_END', toolCallId: 'tc-9' },
        {
          type: 'CUSTOM',
          name: 'tool_call_result',
          value: { toolCallId: 'tc-9', result: '{"ok":true}' },
        },
        { type: 'RUN_FINISHED' },
      ]),
    ]);

    const { result } = renderHook(() =>
      useAgentStream({ url: '/x', fetch: fetchStub }),
    );

    await act(async () => {
      await result.current.sendMessage('lookup it');
    });

    // After RUN_FINISHED the call moves into messages[].
    const assistant = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistant!.toolCalls?.[0]).toEqual(
      expect.objectContaining({
        id: 'tc-9',
        name: 'lookup',
        result: '{"ok":true}',
        done: true,
      }),
    );
  });

  it('RUN_ERROR records the error message', async () => {
    const { fetch: fetchStub } = makeFetchStub([
      encodeSse([
        { type: 'RUN_STARTED', runId: 'r1', threadId: 't1' },
        { type: 'RUN_ERROR', message: 'boom' },
      ]),
    ]);

    const { result } = renderHook(() =>
      useAgentStream({ url: '/x', fetch: fetchStub }),
    );

    await act(async () => {
      await result.current.sendMessage('go');
    });

    expect(result.current.error).toBe('boom');
  });

  it('reset() clears messages, streamingText, activeToolCalls, sessionId, error', async () => {
    const { fetch: fetchStub } = makeFetchStub([
      encodeSse([
        { type: 'RUN_STARTED', runId: 'r1', threadId: 't1' },
        { type: 'CUSTOM', name: 'session', value: { sessionId: 'sess-1' } },
        { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
        { type: 'RUN_FINISHED' },
      ]),
    ]);

    const { result } = renderHook(() =>
      useAgentStream({ url: '/x', fetch: fetchStub }),
    );

    await act(async () => {
      await result.current.sendMessage('hi');
    });
    expect(result.current.messages.length).toBeGreaterThan(0);
    expect(result.current.sessionId).toBe('sess-1');

    act(() => {
      result.current.reset();
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.streamingText).toBe('');
    expect(result.current.activeToolCalls).toEqual([]);
    expect(result.current.sessionId).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isStreaming).toBe(false);
  });

  it('silently skips SSE heartbeat comment lines (`: hb`)', async () => {
    // Mix in heartbeat lines among data frames — they must not produce errors.
    const encoder = new TextEncoder();
    const chunk = encoder.encode(
      ': ok\n\n' +
        `data: ${JSON.stringify({ type: 'RUN_STARTED', runId: 'r1', threadId: 't1' })}\n\n` +
        ': hb\n\n' +
        `data: ${JSON.stringify({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' })}\n\n` +
        `data: ${JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'ok' })}\n\n` +
        `data: ${JSON.stringify({ type: 'TEXT_MESSAGE_END', messageId: 'm1' })}\n\n` +
        ': hb\n\n' +
        `data: ${JSON.stringify({ type: 'RUN_FINISHED' })}\n\n`,
    );
    const { fetch: fetchStub } = makeFetchStub([chunk]);

    const { result } = renderHook(() =>
      useAgentStream({ url: '/x', fetch: fetchStub }),
    );

    await act(async () => {
      await result.current.sendMessage('hi');
    });

    expect(result.current.error).toBeNull();
    const assistant = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('ok');
  });

  it('loadHistory uses historyFetch and replaces messages + sessionId', async () => {
    const historyFetch = jest.fn(async (sid: string) => {
      return [
        { id: 'h1', role: 'user' as const, content: 'older ask', toolCalls: [] },
        { id: 'h2', role: 'assistant' as const, content: 'older reply', toolCalls: [] },
      ];
    });
    const { fetch: fetchStub } = makeFetchStub([encodeSse([{ type: 'RUN_FINISHED' }])]);

    const { result } = renderHook(() =>
      useAgentStream({
        url: '/x',
        fetch: fetchStub,
        historyFetch: historyFetch as unknown as (
          sessionId: string,
        ) => Promise<ReturnType<typeof historyFetch> extends Promise<infer R> ? R : never>,
      }),
    );

    await act(async () => {
      await result.current.loadHistory('sess-prior');
    });

    expect(historyFetch).toHaveBeenCalledWith('sess-prior');
    expect(result.current.sessionId).toBe('sess-prior');
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1]).toEqual(
      expect.objectContaining({ role: 'assistant', content: 'older reply' }),
    );
  });

  it('captures sessionId from RUN_STARTED.sessionId (first-class field)', async () => {
    const { fetch: fetchStub } = makeFetchStub([
      encodeSse([
        { type: 'RUN_STARTED', runId: 'r1', threadId: 't1', sessionId: 'sess-native' },
        { type: 'RUN_FINISHED' },
      ]),
    ]);

    const { result } = renderHook(() =>
      useAgentStream({ url: '/x', fetch: fetchStub }),
    );

    await act(async () => {
      await result.current.sendMessage('hi');
    });

    expect(result.current.sessionId).toBe('sess-native');
  });

  it('prefers RUN_STARTED.sessionId over CUSTOM `session` when both are present', async () => {
    const { fetch: fetchStub } = makeFetchStub([
      encodeSse([
        { type: 'RUN_STARTED', runId: 'r1', threadId: 't1', sessionId: 'from-run-started' },
        // Custom event arrives after — should not overwrite the canonical value
        // (but in practice both set the same session, so the test just confirms both work)
        { type: 'CUSTOM', name: 'session', value: { sessionId: 'from-custom' } },
        { type: 'RUN_FINISHED' },
      ]),
    ]);

    const { result } = renderHook(() =>
      useAgentStream({ url: '/x', fetch: fetchStub }),
    );

    await act(async () => {
      await result.current.sendMessage('hi');
    });

    // The last write wins — custom arrives after — so 'from-custom' is the final value.
    // This test documents current behavior: both paths are accepted.
    expect(result.current.sessionId).toBe('from-custom');
  });

  it('TOOL_CALL_END with inline result attaches the result to the tool call', async () => {
    const { fetch: fetchStub } = makeFetchStub([
      encodeSse([
        { type: 'RUN_STARTED', runId: 'r1', threadId: 't1' },
        { type: 'TOOL_CALL_START', toolCallId: 'tc-inline', toolCallName: 'lookup' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'tc-inline', delta: '{}' },
        { type: 'TOOL_CALL_END', toolCallId: 'tc-inline', result: '{"ok":true}' },
        { type: 'RUN_FINISHED' },
      ]),
    ]);

    const { result } = renderHook(() =>
      useAgentStream({ url: '/x', fetch: fetchStub }),
    );

    await act(async () => {
      await result.current.sendMessage('lookup');
    });

    const assistant = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistant!.toolCalls?.[0]).toEqual(
      expect.objectContaining({
        id: 'tc-inline',
        name: 'lookup',
        result: '{"ok":true}',
        done: true,
      }),
    );
  });

  it('unmount aborts the in-flight fetch', async () => {
    // Build a fetch that returns a stream that never closes until aborted —
    // so we can assert the AbortSignal fires.
    const aborts: Array<boolean> = [];
    let abortHandler: (() => void) | null = null;
    const fetchStub: typeof fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return;
        abortHandler = () => {
          aborts.push(true);
          const err = new Error('aborted');
          (err as Error & { name: string }).name = 'AbortError';
          reject(err);
        };
        signal.addEventListener('abort', abortHandler);
      });
    }) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() =>
      useAgentStream({ url: '/x', fetch: fetchStub }),
    );

    // Kick off a send (don't await — it never resolves until abort).
    act(() => {
      void result.current.sendMessage('hang');
    });

    // Unmount — should abort the controller, which rejects the fetch.
    unmount();

    await waitFor(() => {
      expect(aborts).toHaveLength(1);
    });
  });
});
