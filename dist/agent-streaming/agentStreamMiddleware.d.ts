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
import type { RequestHandler, Request as ExpressRequest } from 'express';
import type { AgentStream } from './types';
/**
 * Buffered provider result — the entire response text is available upfront.
 * The middleware emits a single TEXT_MESSAGE_CONTENT event.
 */
export interface BufferedProviderResult {
    text: string;
}
/**
 * Streaming provider result — text arrives as an AsyncIterable of string
 * chunks. Each chunk is emitted as a separate TEXT_MESSAGE_CONTENT delta,
 * enabling true streaming on the client side.
 */
export interface StreamingProviderResult {
    stream: AsyncIterable<string>;
}
/**
 * Union of all provider result shapes. Return from a handler to have the
 * middleware pipe the response as AG-UI TEXT_MESSAGE_* events automatically.
 *
 * If the handler returns `void` (or `undefined`), no automatic text events
 * are emitted — the handler is responsible for calling all stream methods.
 */
export type ProviderResult = BufferedProviderResult | StreamingProviderResult;
export type AgentStreamHandler = (req: ExpressRequest, stream: AgentStream, signal: AbortSignal) => Promise<ProviderResult | void> | ProviderResult | void;
export interface AgentStreamMiddlewareOptions {
    /** Heartbeat interval in ms. Default 25_000. */
    heartbeatMs?: number;
    /** Derive runId from the request body. Default: body.runId || uuid. */
    deriveRunId?: (req: ExpressRequest) => string;
    /** Derive threadId from the request body. Default: body.threadId || uuid. */
    deriveThreadId?: (req: ExpressRequest) => string;
    /**
     * Derive the application sessionId from the request body or URL params.
     * When provided, the sessionId is emitted on the RUN_STARTED event so
     * clients can correlate the run with a persistent session without needing
     * a separate CUSTOM `session` event.
     *
     * Default: body.sessionId if present, otherwise undefined.
     */
    deriveSessionId?: (req: ExpressRequest) => string | undefined;
    /** Default: NODE_ENV !== 'production'. */
    devValidation?: boolean;
    /** Optional log hook for prod-mode validation violations. */
    onValidationError?: (violation: string) => void;
    /** Hook fired on handler throw — useful for metrics. */
    onHandlerError?: (err: unknown) => void;
}
export declare function agentStreamMiddleware(handler: AgentStreamHandler, opts?: AgentStreamMiddlewareOptions): RequestHandler;
//# sourceMappingURL=agentStreamMiddleware.d.ts.map