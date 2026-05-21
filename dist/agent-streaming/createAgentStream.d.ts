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
import type { Response as ExpressResponse } from 'express';
import type { AgentStream } from './types';
export interface CreateAgentStreamOptions {
    runId: string;
    threadId: string;
    /** Heartbeat interval, default 25_000 ms. Set to 0 to disable. */
    heartbeatMs?: number;
    /** Initial SSE ping body, default `: ok\n\n`. */
    initialPing?: string;
    /** Fired once when the client drops mid-stream. */
    onClientDisconnect?: () => void;
    /** Default: NODE_ENV !== 'production'. */
    devValidation?: boolean;
    /** Optional log hook for prod-mode validation violations. */
    onValidationError?: (violation: string) => void;
    /** Override Date.now (tests). */
    now?: () => number;
    /** Override setInterval / clearInterval (tests with fake timers). */
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
}
export declare function createAgentStream(res: ExpressResponse, opts: CreateAgentStreamOptions): AgentStream;
//# sourceMappingURL=createAgentStream.d.ts.map