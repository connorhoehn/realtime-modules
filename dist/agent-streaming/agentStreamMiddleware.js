"use strict";
/**
 * agentStreamMiddleware — Express route factory for AG-UI POST+SSE handlers.
 *
 * Usage (handler style — full async control):
 *
 *   app.post('/api/agents/:agentId/stream', agentStreamMiddleware(
 *     async (req, stream, signal) => {
 *       const runner = await getAgentRunner(req.params.agentId);
 *       for await (const evt of runner.stream(req.body, { signal })) {
 *         dispatch(evt, stream);
 *       }
 *     }
 *   ));
 *
 * Usage (provider style — buffered or streaming text):
 *
 *   app.post('/api/agents/:agentId/stream', agentStreamMiddleware(
 *     async (req, stream, signal) => {
 *       // Return { text } for buffered response (single textMessageContent):
 *       return { text: await myAgent.invoke(req.body.message, { signal }) };
 *
 *       // Return { stream } for true streaming — each chunk emitted as
 *       // a TEXT_MESSAGE_CONTENT delta:
 *       return { stream: myAgent.streamText(req.body.message, { signal }) };
 *     }
 *   ));
 *
 * Responsibilities:
 *   - Build the AgentStream (`createAgentStream`).
 *   - Pass the handler an AbortSignal that fires on client disconnect.
 *   - Map handler throws to `runError` + close.
 *   - Guarantee `runFinished`/`runError` is emitted before close (best-effort).
 *   - When handler returns a ProviderResult, pipe text or streaming chunks
 *     as TEXT_MESSAGE_CONTENT events automatically.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentStreamMiddleware = agentStreamMiddleware;
const crypto_1 = require("crypto");
const createAgentStream_1 = require("./createAgentStream");
function isBufferedResult(r) {
    return 'text' in r && typeof r.text === 'string';
}
function isStreamingResult(r) {
    return 'stream' in r && r.stream != null;
}
function agentStreamMiddleware(handler, opts = {}) {
    return (req, res, next) => {
        // Only POST is supported (AG-UI spec). Other verbs fall through to
        // the next handler so the host can return 405 / 404 as it sees fit.
        if (req.method !== 'POST') {
            next();
            return;
        }
        const body = (req.body ?? {});
        const runId = opts.deriveRunId?.(req) ??
            (typeof body.runId === 'string' ? body.runId : (0, crypto_1.randomUUID)());
        const threadId = opts.deriveThreadId?.(req) ??
            (typeof body.threadId === 'string' ? body.threadId : (0, crypto_1.randomUUID)());
        const sessionId = opts.deriveSessionId?.(req) ??
            (typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined);
        const controller = new AbortController();
        let handlerFinished = false;
        const stream = (0, createAgentStream_1.createAgentStream)(res, {
            runId,
            threadId,
            heartbeatMs: opts.heartbeatMs,
            devValidation: opts.devValidation,
            onValidationError: opts.onValidationError,
            onClientDisconnect: () => {
                // Propagate cancellation to the handler.
                if (!handlerFinished) {
                    controller.abort();
                }
            },
        });
        // Always emit RUN_STARTED first so the client receives the canonical
        // run + thread identifiers (and optionally the sessionId), even if the
        // handler bails immediately.
        try {
            stream.runStarted({ runId, threadId, ...(sessionId !== undefined ? { sessionId } : {}) });
        }
        catch (err) {
            // Should never happen on a fresh stream, but be defensive.
            opts.onHandlerError?.(err);
            stream.close();
            return;
        }
        Promise.resolve()
            .then(() => handler(req, stream, controller.signal))
            .then(async (result) => {
            handlerFinished = true;
            // --- Provider result auto-piping -----------------------------------
            if (result != null && !stream.closed) {
                const msgId = (0, crypto_1.randomUUID)();
                try {
                    if (isBufferedResult(result)) {
                        // Single-shot: emit the full text as one content delta.
                        stream.textMessageStart(msgId);
                        stream.textMessageContent(msgId, result.text);
                        stream.textMessageEnd(msgId);
                    }
                    else if (isStreamingResult(result)) {
                        // True streaming: pipe each chunk as a delta.
                        stream.textMessageStart(msgId);
                        for await (const chunk of result.stream) {
                            if (stream.closed)
                                break;
                            stream.textMessageContent(msgId, chunk);
                        }
                        if (!stream.closed) {
                            stream.textMessageEnd(msgId);
                        }
                    }
                }
                catch (pipeErr) {
                    // Treat pipe errors as run errors so the client sees them.
                    if (!stream.closed) {
                        const message = pipeErr instanceof Error
                            ? pipeErr.message
                            : String(pipeErr ?? 'stream pipe error');
                        try {
                            stream.runError({ message });
                        }
                        catch {
                            // Run may already have ended — ignore.
                        }
                        stream.close();
                        return;
                    }
                }
            }
            // -------------------------------------------------------------------
            if (!stream.closed) {
                // Caller may have already emitted runFinished/runError. If
                // neither was emitted, default to runFinished so the client
                // exits its streaming state.
                try {
                    stream.runFinished();
                }
                catch {
                    // Already ended — ignore.
                }
                stream.close();
            }
        }, (err) => {
            handlerFinished = true;
            opts.onHandlerError?.(err);
            if (!stream.closed) {
                const message = err instanceof Error ? err.message : String(err ?? 'unknown error');
                try {
                    stream.runError({ message });
                }
                catch {
                    // Run may already have ended — ignore.
                }
                stream.close();
            }
        });
    };
}
//# sourceMappingURL=agentStreamMiddleware.js.map