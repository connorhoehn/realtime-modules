"use strict";
/**
 * createAgentStream — bind an `AgentStream` to an Express Response.
 *
 *   - Sets SSE response headers (text/event-stream + no-cache + keep-alive +
 *     X-Accel-Buffering off for nginx).
 *   - Flushes the head so the client sees `200 OK` before the first event.
 *   - Writes an initial SSE comment (`: ok\n\n`) so the connection is
 *     considered live by intermediate proxies.
 *   - Schedules a heartbeat comment (`: hb\n\n`) every `heartbeatMs`.
 *   - Wires `res.on('close', ...)` to fire onClientDisconnect + clear heartbeat.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAgentStream = createAgentStream;
const AgentStream_1 = require("./AgentStream");
function createAgentStream(res, opts) {
    const heartbeatMs = opts.heartbeatMs ?? 25_000;
    const initialPing = opts.initialPing ?? ': ok\n\n';
    const setIv = opts.setInterval ?? setInterval;
    const clearIv = opts.clearInterval ?? clearInterval;
    // SSE headers — set before any body is written.
    if (!res.headersSent) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        // Flush headers so the client's fetch resolves immediately.
        const flushable = res;
        flushable.flushHeaders?.();
    }
    // Initial ping keeps proxies happy.
    if (initialPing) {
        res.write(initialPing);
    }
    // --- Heartbeat ------------------------------------------------------------
    let heartbeat = null;
    if (heartbeatMs > 0) {
        heartbeat = setIv(() => {
            if (!closed) {
                try {
                    res.write(': hb\n\n');
                }
                catch {
                    stopHeartbeat();
                }
            }
        }, heartbeatMs);
        // Don't hold the event loop open just for the heartbeat.
        if (typeof heartbeat.unref === 'function') {
            heartbeat.unref();
        }
    }
    function stopHeartbeat() {
        if (heartbeat) {
            clearIv(heartbeat);
            heartbeat = null;
        }
    }
    // --- Sink + close handling ------------------------------------------------
    let closed = false;
    const closeListeners = [];
    function markClosed() {
        if (closed)
            return;
        closed = true;
        stopHeartbeat();
        for (const fn of closeListeners) {
            try {
                fn();
            }
            catch {
                // Swallow listener errors — close path must be infallible.
            }
        }
    }
    res.on('close', markClosed);
    const sink = {
        write(chunk) {
            if (closed)
                return false;
            try {
                return res.write(chunk);
            }
            catch {
                markClosed();
                return false;
            }
        },
        end() {
            if (closed)
                return;
            try {
                res.end();
            }
            catch {
                // Best-effort.
            }
            finally {
                markClosed();
            }
        },
        onClose(listener) {
            if (closed) {
                listener();
                return;
            }
            closeListeners.push(listener);
        },
        isClosed() {
            return closed;
        },
    };
    return new AgentStream_1.AgentStreamImpl(sink, {
        runId: opts.runId,
        threadId: opts.threadId,
        devValidation: opts.devValidation,
        onValidationError: opts.onValidationError,
        onClientDisconnect: opts.onClientDisconnect,
        now: opts.now,
    });
}
//# sourceMappingURL=createAgentStream.js.map