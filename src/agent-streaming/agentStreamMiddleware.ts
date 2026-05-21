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
import { randomUUID } from 'crypto';
import { createAgentStream } from './createAgentStream';
import type { AgentStream } from './types';

// --- Provider result types ---------------------------------------------------

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

function isBufferedResult(r: ProviderResult): r is BufferedProviderResult {
  return 'text' in r && typeof (r as BufferedProviderResult).text === 'string';
}

function isStreamingResult(r: ProviderResult): r is StreamingProviderResult {
  return 'stream' in r && (r as StreamingProviderResult).stream != null;
}

// --- Handler + middleware types ----------------------------------------------

export type AgentStreamHandler = (
  req: ExpressRequest,
  stream: AgentStream,
  signal: AbortSignal,
) => Promise<ProviderResult | void> | ProviderResult | void;

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

    const body = (req.body ?? {}) as { runId?: string; threadId?: string; sessionId?: string };
    const runId =
      opts.deriveRunId?.(req) ??
      (typeof body.runId === 'string' ? body.runId : randomUUID());
    const threadId =
      opts.deriveThreadId?.(req) ??
      (typeof body.threadId === 'string' ? body.threadId : randomUUID());
    const sessionId =
      opts.deriveSessionId?.(req) ??
      (typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined);

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
    // run + thread identifiers (and optionally the sessionId), even if the
    // handler bails immediately.
    try {
      stream.runStarted({ runId, threadId, ...(sessionId !== undefined ? { sessionId } : {}) });
    } catch (err) {
      // Should never happen on a fresh stream, but be defensive.
      opts.onHandlerError?.(err);
      stream.close();
      return;
    }

    Promise.resolve()
      .then(() => handler(req, stream, controller.signal))
      .then(
        async (result) => {
          handlerFinished = true;
          // --- Provider result auto-piping -----------------------------------
          if (result != null && !stream.closed) {
            const msgId = randomUUID();
            try {
              if (isBufferedResult(result)) {
                // Single-shot: emit the full text as one content delta.
                stream.textMessageStart(msgId);
                stream.textMessageContent(msgId, result.text);
                stream.textMessageEnd(msgId);
              } else if (isStreamingResult(result)) {
                // True streaming: pipe each chunk as a delta.
                stream.textMessageStart(msgId);
                for await (const chunk of result.stream) {
                  if (stream.closed) break;
                  stream.textMessageContent(msgId, chunk);
                }
                if (!stream.closed) {
                  stream.textMessageEnd(msgId);
                }
              }
            } catch (pipeErr) {
              // Treat pipe errors as run errors so the client sees them.
              if (!stream.closed) {
                const message =
                  pipeErr instanceof Error
                    ? pipeErr.message
                    : String(pipeErr ?? 'stream pipe error');
                try {
                  stream.runError({ message });
                } catch {
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
