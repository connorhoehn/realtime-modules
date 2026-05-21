"use strict";
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
//     sessionId,        // captured from CUSTOM `session` event
//     isStreaming,      // true while a sendMessage() is in flight
//     error,            // last RUN_ERROR or transport error string, or null
//     sendMessage,      // POST + read SSE
//     reset,            // clear in-memory state, abort any in-flight stream
//     loadHistory,      // fetch prior messages for a sessionId
//   }
//
// AG-UI v0.1.x event handling:
//   - RUN_STARTED            → reset streamingText, mark in-progress
//   - RUN_FINISHED           → finalize the in-progress assistant message into messages[]
//   - RUN_ERROR              → record error string, mark stream complete
//   - TEXT_MESSAGE_START     → start a new assistant message
//   - TEXT_MESSAGE_CONTENT   → append delta to streamingText
//   - TEXT_MESSAGE_END       → finalize the in-progress text
//   - TOOL_CALL_START        → push to activeToolCalls (reads toolCallName ?? name for compat)
//   - TOOL_CALL_ARGS         → append delta to the active tool call's args
//   - TOOL_CALL_END          → mark the tool call complete (no result payload per spec)
//   - CUSTOM `session`       → capture sessionId from event.value.sessionId
//   - CUSTOM `tool_call_result` → attach result to matching activeToolCalls[i]
//
// Transport:
//   - POST opts.url with JSON body (default { message }) and opts.headers
//   - Response is text/event-stream; parsed via res.body.getReader() + line splitting
//   - Lines starting with `:` (SSE comment / heartbeat) are silently skipped
//   - Aborts cleanly on unmount or reset()
Object.defineProperty(exports, "__esModule", { value: true });
exports.useAgentStream = useAgentStream;
const react_1 = require("react");
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
function defaultBuildBody(text, ctx) {
    return ctx.sessionId
        ? { message: text, sessionId: ctx.sessionId }
        : { message: text };
}
function randomId() {
    // crypto.randomUUID is widely available (browsers + Node 19+); fall back to
    // a Math.random-based id if not present (jsdom / older runtimes in tests).
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function')
        return c.randomUUID();
    return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
function useAgentStream(opts) {
    const [messages, setMessages] = (0, react_1.useState)([]);
    const [streamingText, setStreamingText] = (0, react_1.useState)('');
    const [activeToolCalls, setActiveToolCalls] = (0, react_1.useState)([]);
    const [sessionId, setSessionIdState] = (0, react_1.useState)(null);
    const [isStreaming, setIsStreaming] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(null);
    // Keep latest sessionId in a ref so `sendMessage` reads the freshest value
    // (its memoized closure would otherwise see the initial null and create a
    // brand-new session on every send).
    const sessionIdRef = (0, react_1.useRef)(null);
    // In-progress assistant message accumulator (mutable; flushed at run end
    // into the immutable messages[]).
    const currentMsgRef = (0, react_1.useRef)({
        id: '',
        content: '',
        toolCalls: [],
    });
    // Per-send AbortController so reset()/unmount can cancel the in-flight read.
    const abortRef = (0, react_1.useRef)(null);
    // Keep opts in a ref so we don't reconstruct sendMessage on every render
    // when callers pass inline objects.
    const optsRef = (0, react_1.useRef)(opts);
    (0, react_1.useEffect)(() => {
        optsRef.current = opts;
    }, [opts]);
    const setSessionId = (0, react_1.useCallback)((sid) => {
        sessionIdRef.current = sid;
        setSessionIdState(sid);
    }, []);
    // ---- Event handler ------------------------------------------------------
    const handleEvent = (0, react_1.useCallback)((event) => {
        switch (event.type) {
            case 'RUN_STARTED': {
                // Spec RUN_STARTED carries only runId/threadId — no sessionId field.
                // Transition-compat: some legacy emitters put it here anyway.
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
                const msg = (typeof event.message === 'string' && event.message) ||
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
                if (!delta)
                    break;
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
                const toolName = (typeof event.toolCallName === 'string' && event.toolCallName) ||
                    (typeof event.name === 'string' && event.name) ||
                    '';
                const id = typeof event.toolCallId === 'string' ? event.toolCallId : randomId();
                const tc = { id, name: toolName, args: '', done: false };
                currentMsgRef.current.toolCalls = [...currentMsgRef.current.toolCalls, tc];
                setActiveToolCalls((prev) => [...prev, tc]);
                break;
            }
            case 'TOOL_CALL_ARGS': {
                const id = event.toolCallId;
                const delta = typeof event.delta === 'string' ? event.delta : '';
                if (typeof id !== 'string' || !delta)
                    break;
                const tcRef = currentMsgRef.current.toolCalls.find((t) => t.id === id);
                if (tcRef)
                    tcRef.args += delta;
                setActiveToolCalls((prev) => prev.map((t) => (t.id === id ? { ...t, args: t.args + delta } : t)));
                break;
            }
            case 'TOOL_CALL_END': {
                // Spec: TOOL_CALL_END carries no result payload (a separate
                // TOOL_CALL_RESULT or CUSTOM `tool_call_result` does). Just mark done.
                const id = event.toolCallId;
                if (typeof id !== 'string')
                    break;
                const tcRef = currentMsgRef.current.toolCalls.find((t) => t.id === id);
                if (tcRef)
                    tcRef.done = true;
                setActiveToolCalls((prev) => prev.map((t) => (t.id === id ? { ...t, done: true } : t)));
                break;
            }
            case 'TOOL_CALL_RESULT': {
                // AG-UI v0.1.x: separate event after TOOL_CALL_END with `content`.
                const id = event.toolCallId;
                if (typeof id !== 'string')
                    break;
                const result = String(event.content ?? '');
                const tcRef = currentMsgRef.current.toolCalls.find((t) => t.id === id);
                if (tcRef) {
                    tcRef.result = result;
                    tcRef.done = true;
                }
                setActiveToolCalls((prev) => prev.map((t) => (t.id === id ? { ...t, result, done: true } : t)));
                break;
            }
            case 'CUSTOM': {
                // OrgIQ side-channels two payloads via CUSTOM:
                //   - name: 'session'           → { sessionId } (RUN_STARTED can't carry it per spec)
                //   - name: 'tool_call_result'  → { toolCallId, result } (TOOL_CALL_END can't carry it)
                const name = event.name;
                const value = event.value;
                if (name === 'session' && value && typeof value.sessionId === 'string' && value.sessionId) {
                    setSessionId(value.sessionId);
                }
                else if (name === 'tool_call_result' && value && typeof value.toolCallId === 'string') {
                    const id = value.toolCallId;
                    const result = String(value.result ?? '');
                    const tcRef = currentMsgRef.current.toolCalls.find((t) => t.id === id);
                    if (tcRef) {
                        tcRef.result = result;
                        tcRef.done = true;
                    }
                    setActiveToolCalls((prev) => prev.map((t) => (t.id === id ? { ...t, result, done: true } : t)));
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
    const sendMessage = (0, react_1.useCallback)(async (text) => {
        const o = optsRef.current;
        const userMsg = {
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
        const fetchImpl = o.fetch ?? globalThis.fetch;
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
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const rawLine of lines) {
                    const line = rawLine.replace(/\r$/, '');
                    if (!line)
                        continue;
                    // SSE comment lines (heartbeats like `: hb` or `: ok`) — silently skip.
                    if (line.startsWith(':'))
                        continue;
                    if (!line.startsWith('data: '))
                        continue;
                    const payload = line.slice(6);
                    if (!payload)
                        continue;
                    try {
                        const event = JSON.parse(payload);
                        handleEvent(event);
                    }
                    catch {
                        // Malformed frame — skip.
                    }
                }
            }
        }
        catch (err) {
            const e = err;
            if (e && e.name !== 'AbortError') {
                setError(e.message || 'Stream error');
            }
        }
        finally {
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
    const reset = (0, react_1.useCallback)(() => {
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
    const loadHistory = (0, react_1.useCallback)(async (sid) => {
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
        }
        catch (err) {
            const e = err;
            setError(e?.message || 'Failed to load history');
        }
    }, [setSessionId]);
    // ---- Cleanup on unmount -------------------------------------------------
    (0, react_1.useEffect)(() => {
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
//# sourceMappingURL=useAgentStream.js.map