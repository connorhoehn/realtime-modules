// realtime-modules/src/client/useAgentStream.ts
//
// useAgentStream — React hook that consumes an AG-UI v0.1.x SSE stream
// produced by `agentStreamMiddleware` (or any peer that follows the
// `createAgentStream` wire format).
//
// Replaces hand-rolled FE hooks like OrgIQ's `useAgUiStream.ts` (~188 LOC)
// with a single library import. Pairs server-side with
// `@connorhoehn/realtime-modules/agent-streaming`.
//
// Returned surface (superset of OrgIQ's shape so adoption is a 1-line swap):
//
//   {
//     messages,         // accumulated full Message[]
//     streamingText,    // in-progress text being assembled from TEXT_MESSAGE_CONTENT deltas
//     activeToolCalls,  // ToolCall[] in flight (TOOL_CALL_START fired, TOOL_CALL_END not yet)
//     sessionId,        // captured from RUN_STARTED.sessionId (or CUSTOM `session` for compat)
//     isStreaming,      // true while a sendMessage() is in flight
//     error,            // last RUN_ERROR or transport error string, or null
//     sendMessage,      // POST + read SSE
//     reset,            // clear in-memory state, abort any in-flight stream
//     loadHistory,      // fetch prior messages for a sessionId
//   }
//
// AG-UI v0.1.x event handling:
//   - RUN_STARTED            → reset streamingText, capture sessionId if present
//   - RUN_FINISHED           → finalize the in-progress assistant message into messages[]
//   - RUN_ERROR              → record error string, mark stream complete
//   - TEXT_MESSAGE_START     → start a new assistant message
//   - TEXT_MESSAGE_CONTENT   → append delta to streamingText
//   - TEXT_MESSAGE_END       → finalize the in-progress text
//   - TOOL_CALL_START        → push to activeToolCalls (reads toolCallName ?? name for compat)
//   - TOOL_CALL_ARGS         → append delta to the active tool call's args
//   - TOOL_CALL_END          → mark tool call done; if result field present, attach it
//   - TOOL_CALL_RESULT       → attach result to matching tool call (standard AG-UI post-END event)
//   - CUSTOM `session`       → backward compat: capture sessionId (superseded by RUN_STARTED.sessionId)
//   - CUSTOM `tool_call_result` → backward compat: attach result (superseded by TOOL_CALL_RESULT)
//
// Transport:
//   - POST opts.url with JSON body (default { message }) and opts.headers
//   - Response is text/event-stream; parsed via res.body.getReader() + line splitting
//   - Lines starting with `:` (SSE comment / heartbeat) are silently skipped
//   - Aborts cleanly on unmount or reset()

import { useState, useCallback, useRef, useEffect } from 'react';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
 * Body builder — given the user-typed text plus the current sessionId (if any),
 * produce the JSON body to POST. Defaults to `{ message, sessionId? }`.
 */
export type BuildBody = (
  text: string,
  ctx: { sessionId: string | null },
) => unknown;

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
  sendMessage: (text: string) => Promise<void>;
  reset: () => void;
  loadHistory: (sessionId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function defaultBuildBody(text: string, ctx: { sessionId: string | null }): unknown {
  return ctx.sessionId
    ? { message: text, sessionId: ctx.sessionId }
    : { message: text };
}

function randomId(): string {
  // crypto.randomUUID is widely available (browsers + Node 19+); fall back to
  // a Math.random-based id if not present (jsdom / older runtimes in tests).
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function useAgentStream(
  opts: UseAgentStreamOptions,
): UseAgentStreamReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCall[]>([]);
  const [sessionId, setSessionIdState] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep latest sessionId in a ref so `sendMessage` reads the freshest value
  // (its memoized closure would otherwise see the initial null and create a
  // brand-new session on every send).
  const sessionIdRef = useRef<string | null>(null);

  // In-progress assistant message accumulator (mutable; flushed at run end
  // into the immutable messages[]).
  const currentMsgRef = useRef<{ id: string; content: string; toolCalls: ToolCall[] }>({
    id: '',
    content: '',
    toolCalls: [],
  });

  // Per-send AbortController so reset()/unmount can cancel the in-flight read.
  const abortRef = useRef<AbortController | null>(null);

  // Keep opts in a ref so we don't reconstruct sendMessage on every render
  // when callers pass inline objects.
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

  const setSessionId = useCallback((sid: string | null) => {
    sessionIdRef.current = sid;
    setSessionIdState(sid);
  }, []);

  // ---- Event handler ------------------------------------------------------
  const handleEvent = useCallback((event: Record<string, unknown>): void => {
    switch (event.type) {
      case 'RUN_STARTED': {
        // sessionId is now a first-class field on RUN_STARTED (normalised gap fix).
        // Also accepted here for backward compat with older server versions.
        if (typeof event.sessionId === 'string' && event.sessionId) {
          setSessionId(event.sessionId);
        }
        setStreamingText('');
        break;
      }
      case 'RUN_FINISHED': {
        // Flush the in-progress assistant message into messages[].
        const cur = currentMsgRef.current;
        if (cur.content || (cur.toolCalls && cur.toolCalls.length > 0)) {
          setMessages((prev) => [
            ...prev,
            {
              id: cur.id || randomId(),
              role: 'assistant',
              content: cur.content,
              toolCalls: cur.toolCalls,
            },
          ]);
        }
        currentMsgRef.current = { id: '', content: '', toolCalls: [] };
        setStreamingText('');
        setActiveToolCalls([]);
        break;
      }
      case 'RUN_ERROR': {
        // AG-UI v0.1.x spec: `message`. Legacy emitters used `error`. Accept both.
        const msg =
          (typeof event.message === 'string' && event.message) ||
          (typeof event.error === 'string' && event.error) ||
          'Agent run failed';
        setError(msg);
        break;
      }
      case 'TEXT_MESSAGE_START': {
        if (typeof event.messageId === 'string') {
          currentMsgRef.current.id = event.messageId;
        }
        break;
      }
      case 'TEXT_MESSAGE_CONTENT': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (!delta) break;
        currentMsgRef.current.content += delta;
        setStreamingText((prev) => prev + delta);
        break;
      }
      case 'TEXT_MESSAGE_END': {
        // Finalize the text into messages[]. We do this here (rather than only
        // at RUN_FINISHED) so multi-message runs are flushed incrementally.
        const cur = currentMsgRef.current;
        if (cur.content || (cur.toolCalls && cur.toolCalls.length > 0)) {
          setMessages((prev) => [
            ...prev,
            {
              id: cur.id || randomId(),
              role: 'assistant',
              content: cur.content,
              toolCalls: cur.toolCalls,
            },
          ]);
          currentMsgRef.current = { id: '', content: '', toolCalls: [] };
          setStreamingText('');
        }
        break;
      }
      case 'TOOL_CALL_START': {
        // Canonical AG-UI v0.1.x field is `toolCallName`. Some legacy emitters
        // used `name` — accept both for transition compat.
        const toolName =
          (typeof event.toolCallName === 'string' && event.toolCallName) ||
          (typeof event.name === 'string' && event.name) ||
          '';
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : randomId();
        const tc: ToolCall = { id, name: toolName, args: '', done: false };
        currentMsgRef.current.toolCalls = [...currentMsgRef.current.toolCalls, tc];
        setActiveToolCalls((prev) => [...prev, tc]);
        break;
      }
      case 'TOOL_CALL_ARGS': {
        const id = event.toolCallId;
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (typeof id !== 'string' || !delta) break;
        const tcRef = currentMsgRef.current.toolCalls.find((t) => t.id === id);
        if (tcRef) tcRef.args += delta;
        setActiveToolCalls((prev) =>
          prev.map((t) => (t.id === id ? { ...t, args: t.args + delta } : t)),
        );
        break;
      }
      case 'TOOL_CALL_END': {
        // Mark tool call done. If an inline `result` is present (convenience
        // extension on the TOOL_CALL_END event), attach it — equivalent to
        // receiving a follow-up TOOL_CALL_RESULT event.
        const id = event.toolCallId;
        if (typeof id !== 'string') break;
        const hasResult = 'result' in event;
        const inlineResult = hasResult ? String(event.result ?? '') : undefined;
        const tcRef = currentMsgRef.current.toolCalls.find((t) => t.id === id);
        if (tcRef) {
          tcRef.done = true;
          if (inlineResult !== undefined) tcRef.result = inlineResult;
        }
        setActiveToolCalls((prev) =>
          prev.map((t) =>
            t.id === id
              ? { ...t, done: true, ...(inlineResult !== undefined ? { result: inlineResult } : {}) }
              : t,
          ),
        );
        break;
      }
      case 'TOOL_CALL_RESULT': {
        // AG-UI v0.1.x: separate event after TOOL_CALL_END with `content`.
        const id = event.toolCallId;
        if (typeof id !== 'string') break;
        const result = String((event as { content?: unknown }).content ?? '');
        const tcRef = currentMsgRef.current.toolCalls.find((t) => t.id === id);
        if (tcRef) {
          tcRef.result = result;
          tcRef.done = true;
        }
        setActiveToolCalls((prev) =>
          prev.map((t) => (t.id === id ? { ...t, result, done: true } : t)),
        );
        break;
      }
      case 'CUSTOM': {
        // Backward-compat side-channels from pre-normalization server code:
        //   - name: 'session'           → { sessionId }; superseded by RUN_STARTED.sessionId
        //   - name: 'tool_call_result'  → { toolCallId, result }; superseded by TOOL_CALL_RESULT
        // Both remain handled here so older server versions keep working.
        const name = event.name;
        const value = event.value as Record<string, unknown> | undefined;
        if (name === 'session' && value && typeof value.sessionId === 'string' && value.sessionId) {
          setSessionId(value.sessionId);
        } else if (name === 'tool_call_result' && value && typeof value.toolCallId === 'string') {
          const id = value.toolCallId;
          const result = String(value.result ?? '');
          const tcRef = currentMsgRef.current.toolCalls.find((t) => t.id === id);
          if (tcRef) {
            tcRef.result = result;
            tcRef.done = true;
          }
          setActiveToolCalls((prev) =>
            prev.map((t) => (t.id === id ? { ...t, result, done: true } : t)),
          );
        }
        break;
      }
      // All other event types (STATE_*, REASONING_*, ACTIVITY_*, RAW, META_EVENT,
      // STEP_STARTED/FINISHED, TEXT_MESSAGE_CHUNK, TOOL_CALL_CHUNK) are ignored
      // for now — consumers that need them can subscribe via a follow-up
      // option without breaking existing callers.
      default:
        break;
    }
  }, [setSessionId]);

  // ---- sendMessage --------------------------------------------------------
  const sendMessage = useCallback(async (text: string): Promise<void> => {
    const o = optsRef.current;
    const userMsg: Message = {
      id: randomId(),
      role: 'user',
      content: text,
      toolCalls: [],
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsStreaming(true);
    setStreamingText('');
    setActiveToolCalls([]);
    setError(null);
    currentMsgRef.current = { id: '', content: '', toolCalls: [] };

    const controller = new AbortController();
    abortRef.current = controller;

    const fetchImpl: typeof fetch = o.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      setError('fetch is unavailable in this environment');
      setIsStreaming(false);
      abortRef.current = null;
      return;
    }

    const builder = o.buildBody ?? defaultBuildBody;
    const body = builder(text, { sessionId: sessionIdRef.current });

    try {
      const res = await fetchImpl(o.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(o.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Stream failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, '');
          if (!line) continue;
          // SSE comment lines (heartbeats like `: hb` or `: ok`) — silently skip.
          if (line.startsWith(':')) continue;
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (!payload) continue;
          try {
            const event = JSON.parse(payload) as Record<string, unknown>;
            handleEvent(event);
          } catch {
            // Malformed frame — skip.
          }
        }
      }
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e && e.name !== 'AbortError') {
        setError(e.message || 'Stream error');
      }
    } finally {
      // Flush any in-progress assistant message that wasn't closed by an
      // explicit TEXT_MESSAGE_END / RUN_FINISHED (e.g. server cut the stream).
      const cur = currentMsgRef.current;
      if (cur.content || (cur.toolCalls && cur.toolCalls.length > 0)) {
        setMessages((prev) => [
          ...prev,
          {
            id: cur.id || randomId(),
            role: 'assistant',
            content: cur.content,
            toolCalls: cur.toolCalls,
          },
        ]);
      }
      currentMsgRef.current = { id: '', content: '', toolCalls: [] };
      setStreamingText('');
      setActiveToolCalls([]);
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [handleEvent]);

  // ---- reset --------------------------------------------------------------
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    currentMsgRef.current = { id: '', content: '', toolCalls: [] };
    setMessages([]);
    setStreamingText('');
    setActiveToolCalls([]);
    setError(null);
    setIsStreaming(false);
    setSessionId(null);
  }, [setSessionId]);

  // ---- loadHistory --------------------------------------------------------
  const loadHistory = useCallback(async (sid: string): Promise<void> => {
    abortRef.current?.abort();
    abortRef.current = null;
    currentMsgRef.current = { id: '', content: '', toolCalls: [] };
    setStreamingText('');
    setActiveToolCalls([]);
    setError(null);
    setIsStreaming(false);
    setSessionId(sid);

    const fetcher = optsRef.current.historyFetch;
    if (!fetcher) {
      // No fetcher wired — caller may set messages themselves via state.
      // Treat as a sessionId-only switch.
      setMessages([]);
      return;
    }
    try {
      const msgs = await fetcher(sid);
      setMessages(msgs);
    } catch (err) {
      const e = err as { message?: string };
      setError(e?.message || 'Failed to load history');
    }
  }, [setSessionId]);

  // ---- Cleanup on unmount -------------------------------------------------
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  return {
    messages,
    streamingText,
    activeToolCalls,
    sessionId,
    isStreaming,
    error,
    sendMessage,
    reset,
    loadHistory,
  };
}
