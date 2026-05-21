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
import { AgentStreamImpl, type StreamSink } from './AgentStream';
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

export function createAgentStream(
  res: ExpressResponse,
  opts: CreateAgentStreamOptions,
): AgentStream {
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
    const flushable = res as ExpressResponse & { flushHeaders?: () => void };
    flushable.flushHeaders?.();
  }

  // Initial ping keeps proxies happy.
  if (initialPing) {
    res.write(initialPing);
  }

  // --- Heartbeat ------------------------------------------------------------

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (heartbeatMs > 0) {
    heartbeat = setIv(() => {
      if (!closed) {
        try {
          res.write(': hb\n\n');
        } catch {
          stopHeartbeat();
        }
      }
    }, heartbeatMs);
    // Don't hold the event loop open just for the heartbeat.
    if (typeof (heartbeat as NodeJS.Timeout).unref === 'function') {
      (heartbeat as NodeJS.Timeout).unref();
    }
  }

  function stopHeartbeat(): void {
    if (heartbeat) {
      clearIv(heartbeat as NodeJS.Timeout);
      heartbeat = null;
    }
  }

  // --- Sink + close handling ------------------------------------------------

  let closed = false;
  const closeListeners: Array<() => void> = [];

  function markClosed(): void {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    for (const fn of closeListeners) {
      try {
        fn();
      } catch {
        // Swallow listener errors — close path must be infallible.
      }
    }
  }

  res.on('close', markClosed);

  const sink: StreamSink = {
    write(chunk: string): boolean {
      if (closed) return false;
      try {
        return res.write(chunk);
      } catch {
        markClosed();
        return false;
      }
    },
    end(): void {
      if (closed) return;
      try {
        res.end();
      } catch {
        // Best-effort.
      } finally {
        markClosed();
      }
    },
    onClose(listener: () => void): void {
      if (closed) {
        listener();
        return;
      }
      closeListeners.push(listener);
    },
    isClosed(): boolean {
      return closed;
    },
  };

  return new AgentStreamImpl(sink, {
    runId: opts.runId,
    threadId: opts.threadId,
    devValidation: opts.devValidation,
    onValidationError: opts.onValidationError,
    onClientDisconnect: opts.onClientDisconnect,
    now: opts.now,
  });
}
