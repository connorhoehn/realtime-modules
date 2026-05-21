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
import { randomUUID } from 'crypto';
import { createAgentStream } from './createAgentStream';
import type { AgentStream } from './types';

export type AgentStreamHandler = (
  req: ExpressRequest,
  stream: AgentStream,
  signal: AbortSignal,
) => Promise<void> | void;

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

export function agentStreamMiddleware(
  handler: AgentStreamHandler,
  opts: AgentStreamMiddlewareOptions = {},
): RequestHandler {
  return (req, res, next) => {
    // Only POST is supported (AG-UI spec). Other verbs fall through to
    // the next handler so the host can return 405 / 404 as it sees fit.
    if (req.method !== 'POST') {
      next();
      return;
    }

    const body = (req.body ?? {}) as { runId?: string; threadId?: string };
    const runId =
      opts.deriveRunId?.(req) ??
      (typeof body.runId === 'string' ? body.runId : randomUUID());
    const threadId =
      opts.deriveThreadId?.(req) ??
      (typeof body.threadId === 'string' ? body.threadId : randomUUID());

    const controller = new AbortController();
    let handlerFinished = false;

    const stream = createAgentStream(res, {
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
    } catch (err) {
      // Should never happen on a fresh stream, but be defensive.
      opts.onHandlerError?.(err);
      stream.close();
      return;
    }

    Promise.resolve()
      .then(() => handler(req, stream, controller.signal))
      .then(
        () => {
          handlerFinished = true;
          if (!stream.closed) {
            // Caller may have already emitted runFinished/runError. If
            // neither was emitted, default to runFinished so the client
            // exits its streaming state.
            try {
              stream.runFinished();
            } catch {
              // Already ended — ignore.
            }
            stream.close();
          }
        },
        (err: unknown) => {
          handlerFinished = true;
          opts.onHandlerError?.(err);
          if (!stream.closed) {
            const message =
              err instanceof Error ? err.message : String(err ?? 'unknown error');
            try {
              stream.runError({ message });
            } catch {
              // Run may already have ended — ignore.
            }
            stream.close();
          }
        },
      );
  };
}
