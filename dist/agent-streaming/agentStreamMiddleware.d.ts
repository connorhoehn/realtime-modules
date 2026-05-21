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
import type { RequestHandler, Request as ExpressRequest } from 'express';
import type { AgentStream } from './types';
export type AgentStreamHandler = (req: ExpressRequest, stream: AgentStream, signal: AbortSignal) => Promise<void> | void;
export interface AgentStreamMiddlewareOptions {
    /** Heartbeat interval in ms. Default 25_000. */
    heartbeatMs?: number;
    /** Derive runId from the request body. Default: body.runId || uuid. */
    deriveRunId?: (req: ExpressRequest) => string;
    /** Derive threadId from the request body. Default: body.threadId || uuid. */
    deriveThreadId?: (req: ExpressRequest) => string;
    /** Default: NODE_ENV !== 'production'. */
    devValidation?: boolean;
    /** Optional log hook for prod-mode validation violations. */
    onValidationError?: (violation: string) => void;
    /** Hook fired on handler throw — useful for metrics. */
    onHandlerError?: (err: unknown) => void;
}
export declare function agentStreamMiddleware(handler: AgentStreamHandler, opts?: AgentStreamMiddlewareOptions): RequestHandler;
//# sourceMappingURL=agentStreamMiddleware.d.ts.map