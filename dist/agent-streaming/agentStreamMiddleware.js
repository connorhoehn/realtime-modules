"use strict";
/**
 * agentStreamMiddleware — Express route factory for AG-UI POST+SSE handlers.
 *
 * Usage:
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
 * Responsibilities:
 *   - Build the AgentStream (`createAgentStream`).
 *   - Pass the handler an AbortSignal that fires on client disconnect.
 *   - Map handler throws to `runError` + close.
 *   - Guarantee `runFinished`/`runError` is emitted before close (best-effort).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentStreamMiddleware = agentStreamMiddleware;
const crypto_1 = require("crypto");
const createAgentStream_1 = require("./createAgentStream");
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
        // run + thread identifiers, even if the handler bails immediately.
        try {
            stream.runStarted({ runId, threadId });
        }
        catch (err) {
            // Should never happen on a fresh stream, but be defensive.
            opts.onHandlerError?.(err);
            stream.close();
            return;
        }
        Promise.resolve()
            .then(() => handler(req, stream, controller.signal))
            .then(() => {
            handlerFinished = true;
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