/**
 * Integration tests for agentStreamMiddleware — spin up a real Express
 * app, drive it via supertest, parse the SSE stream, and verify event
 * ordering + cleanup semantics.
 */

import express from 'express';
import http from 'http';
import { agentStreamMiddleware } from '../../src/agent-streaming/agentStreamMiddleware';
import type { AgentStream } from '../../src/agent-streaming/types';

interface ParsedSse {
  events: Array<Record<string, unknown>>;
  comments: string[];
}

function parseSse(raw: string): ParsedSse {
  const out: ParsedSse = { events: [], comments: [] };
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue;
    if (block.startsWith(':')) {
      out.comments.push(block.slice(1).trim());
      continue;
    }
    if (block.startsWith('data: ')) {
      const body = block.slice('data: '.length);
      try {
        out.events.push(JSON.parse(body));
      } catch {
        // Ignore unparseable frames (test will catch via assertions).
      }
    }
  }
  return out;
}

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to bind'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}`;
      const close = () =>
        new Promise<void>((res, rej) =>
          server.close((err) => (err ? rej(err) : res())),
        );
      resolve({ url, close });
    });
  });
}

async function fetchSse(url: string, body: unknown, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  });
  return await res.text();
}

describe('agentStreamMiddleware — end-to-end SSE', () => {
  it('serves the canonical RUN_STARTED → text → RUN_FINISHED sequence', async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/api/agents/test/stream',
      agentStreamMiddleware(async (_req, stream: AgentStream) => {
        stream.textMessageStart('m-1');
        stream.textMessageContent('m-1', 'Hello');
        stream.textMessageContent('m-1', ' world');
        stream.textMessageEnd('m-1');
        stream.runFinished({ outcome: 'success' });
      }),
    );

    const { url, close } = await listen(app);
    try {
      const raw = await fetchSse(`${url}/api/agents/test/stream`, {
        messages: [{ role: 'user', content: 'hi' }],
      });
      const parsed = parseSse(raw);

      expect(parsed.events.map((e) => e.type)).toEqual([
        'RUN_STARTED',
        'TEXT_MESSAGE_START',
        'TEXT_MESSAGE_CONTENT',
        'TEXT_MESSAGE_CONTENT',
        'TEXT_MESSAGE_END',
        'RUN_FINISHED',
      ]);
      expect(parsed.events[0]).toMatchObject({
        type: 'RUN_STARTED',
        runId: expect.any(String),
        threadId: expect.any(String),
      });
      expect(parsed.comments).toContain('ok');
    } finally {
      await close();
    }
  });

  it('preserves the request body runId + threadId', async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/api/agents/test/stream',
      agentStreamMiddleware(async (_req, stream) => {
        stream.runFinished();
      }),
    );

    const { url, close } = await listen(app);
    try {
      const raw = await fetchSse(`${url}/api/agents/test/stream`, {
        runId: 'caller-run',
        threadId: 'caller-thread',
      });
      const parsed = parseSse(raw);
      expect(parsed.events[0]).toMatchObject({
        type: 'RUN_STARTED',
        runId: 'caller-run',
        threadId: 'caller-thread',
      });
    } finally {
      await close();
    }
  });

  it('emits TOOL_CALL_START with toolCallName (regression-pinned wire shape)', async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/api/agents/test/stream',
      agentStreamMiddleware(async (_req, stream) => {
        stream.toolCallStart('tc-1', 'search', 'm-1');
        stream.toolCallArgs('tc-1', '{"q":"hi"}');
        stream.toolCallEnd('tc-1');
        stream.toolCallResult('m-1', 'tc-1', { rows: [1] });
        stream.runFinished();
      }),
    );

    const { url, close } = await listen(app);
    try {
      const raw = await fetchSse(`${url}/api/agents/test/stream`, {});
      const parsed = parseSse(raw);
      const start = parsed.events.find((e) => e.type === 'TOOL_CALL_START')!;
      const args = parsed.events.find((e) => e.type === 'TOOL_CALL_ARGS')!;
      const end = parsed.events.find((e) => e.type === 'TOOL_CALL_END')!;
      const result = parsed.events.find((e) => e.type === 'TOOL_CALL_RESULT')!;

      expect(start.toolCallName).toBe('search');
      expect(start.toolName).toBeUndefined();
      expect(args.delta).toBe('{"q":"hi"}');
      expect(args.args).toBeUndefined();
      // END must NOT carry the result inline.
      expect(end.content).toBeUndefined();
      expect(end.result).toBeUndefined();
      // RESULT is its own event with both ids + content.
      expect(result.messageId).toBe('m-1');
      expect(result.toolCallId).toBe('tc-1');
      expect(result.content).toEqual({ rows: [1] });
    } finally {
      await close();
    }
  });

  it('handler throws → RUN_ERROR.message is emitted', async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/api/agents/test/stream',
      agentStreamMiddleware(async () => {
        throw new Error('boom');
      }),
    );

    const { url, close } = await listen(app);
    try {
      const raw = await fetchSse(`${url}/api/agents/test/stream`, {});
      const parsed = parseSse(raw);
      const errEvt = parsed.events.find((e) => e.type === 'RUN_ERROR');
      expect(errEvt).toBeDefined();
      expect(errEvt!.message).toBe('boom');
      expect(errEvt!.error).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('emits a default RUN_FINISHED if the handler returns without one', async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/api/agents/test/stream',
      agentStreamMiddleware(async (_req, stream) => {
        stream.textMessageStart('m-1');
        stream.textMessageEnd('m-1');
        // Note: handler does NOT call runFinished.
      }),
    );

    const { url, close } = await listen(app);
    try {
      const raw = await fetchSse(`${url}/api/agents/test/stream`, {});
      const parsed = parseSse(raw);
      const types = parsed.events.map((e) => e.type);
      expect(types[types.length - 1]).toBe('RUN_FINISHED');
    } finally {
      await close();
    }
  });

  it('client disconnect aborts the handler signal', async () => {
    let signalAborted = false;
    let handlerComplete = false;

    const app = express();
    app.use(express.json());
    app.post(
      '/api/agents/test/stream',
      agentStreamMiddleware(async (_req, stream, signal) => {
        await new Promise<void>((resolve) => {
          // Resolve when the abort fires; never on its own.
          signal.addEventListener('abort', () => {
            signalAborted = true;
            resolve();
          });
        });
        try {
          stream.runFinished();
        } catch {
          // OK if already closed
        }
        handlerComplete = true;
      }),
    );

    const { url, close } = await listen(app);
    try {
      const controller = new AbortController();
      const inFlight = fetch(`${url}/api/agents/test/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      // Give the server a moment to start the handler.
      await new Promise((r) => setTimeout(r, 50));
      controller.abort();
      // Swallow the AbortError on the client side.
      await inFlight.catch(() => undefined);
      // Allow Node to fire the `close` event on the server.
      await new Promise((r) => setTimeout(r, 100));
      expect(signalAborted).toBe(true);
      expect(handlerComplete).toBe(true);
    } finally {
      await close();
    }
  });

  it('passes non-POST through to next handler', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/agents/test/stream',
      agentStreamMiddleware(async (_req, stream) => {
        stream.runFinished();
      }),
    );
    app.use((_req, res) => res.status(405).send('Method Not Allowed'));

    const { url, close } = await listen(app);
    try {
      const res = await fetch(`${url}/api/agents/test/stream`, { method: 'GET' });
      expect(res.status).toBe(405);
    } finally {
      await close();
    }
  });

  // --- New gap-normalization tests -------------------------------------------

  it('emits sessionId on RUN_STARTED when body.sessionId is provided', async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/api/agents/test/stream',
      agentStreamMiddleware(async (_req, stream) => {
        stream.runFinished();
      }),
    );

    const { url, close } = await listen(app);
    try {
      const raw = await fetchSse(`${url}/api/agents/test/stream`, {
        sessionId: 'sess-from-body',
      });
      const parsed = parseSse(raw);
      expect(parsed.events[0]).toMatchObject({
        type: 'RUN_STARTED',
        sessionId: 'sess-from-body',
      });
    } finally {
      await close();
    }
  });

  it('emits sessionId on RUN_STARTED when deriveSessionId option is provided', async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/api/agents/test/stream',
      agentStreamMiddleware(
        async (_req, stream) => {
          stream.runFinished();
        },
        { deriveSessionId: (req) => (req.body as { sessionId?: string }).sessionId ?? 'derived-id' },
      ),
    );

    const { url, close } = await listen(app);
    try {
      const raw = await fetchSse(`${url}/api/agents/test/stream`, {});
      const parsed = parseSse(raw);
      expect(parsed.events[0]).toMatchObject({
        type: 'RUN_STARTED',
        sessionId: 'derived-id',
      });
    } finally {
      await close();
    }
  });

  it('omits sessionId from RUN_STARTED when none is provided', async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/api/agents/test/stream',
      agentStreamMiddleware(async (_req, stream) => {
        stream.runFinished();
      }),
    );

    const { url, close } = await listen(app);
    try {
      const raw = await fetchSse(`${url}/api/agents/test/stream`, {});
      const parsed = parseSse(raw);
      expect(parsed.events[0].type).toBe('RUN_STARTED');
      expect(parsed.events[0].sessionId).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('buffered provider result ({ text }) emits TEXT_MESSAGE_* around the text', async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/api/agents/test/stream',
      agentStreamMiddleware(async () => {
        return { text: 'Hello from provider' };
      }),
    );

    const { url, close } = await listen(app);
    try {
      const raw = await fetchSse(`${url}/api/agents/test/stream`, {});
      const parsed = parseSse(raw);
      const types = parsed.events.map((e) => e.type);
      expect(types).toContain('TEXT_MESSAGE_START');
      expect(types).toContain('TEXT_MESSAGE_CONTENT');
      expect(types).toContain('TEXT_MESSAGE_END');
      expect(types).toContain('RUN_FINISHED');
      const content = parsed.events.find((e) => e.type === 'TEXT_MESSAGE_CONTENT');
      expect(content?.delta).toBe('Hello from provider');
    } finally {
      await close();
    }
  });

  it('streaming provider result ({ stream }) pipes each chunk as TEXT_MESSAGE_CONTENT', async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/api/agents/test/stream',
      agentStreamMiddleware(async () => {
        async function* gen(): AsyncIterable<string> {
          yield 'chunk1';
          yield ' chunk2';
          yield ' chunk3';
        }
        return { stream: gen() };
      }),
    );

    const { url, close } = await listen(app);
    try {
      const raw = await fetchSse(`${url}/api/agents/test/stream`, {});
      const parsed = parseSse(raw);
      const contentEvents = parsed.events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT');
      expect(contentEvents).toHaveLength(3);
      expect(contentEvents.map((e) => e.delta)).toEqual(['chunk1', ' chunk2', ' chunk3']);
      // Full lifecycle present
      const types = parsed.events.map((e) => e.type);
      expect(types[0]).toBe('RUN_STARTED');
      expect(types[types.length - 1]).toBe('RUN_FINISHED');
    } finally {
      await close();
    }
  });

  it('TOOL_CALL_END with inline result emits the result field', async () => {
    const app = express();
    app.use(express.json());
    app.post(
      '/api/agents/test/stream',
      agentStreamMiddleware(async (_req, stream) => {
        stream.toolCallStart('tc-1', 'lookup');
        stream.toolCallArgs('tc-1', '{}');
        stream.toolCallEnd('tc-1', { answer: 42 });
        stream.runFinished();
      }),
    );

    const { url, close } = await listen(app);
    try {
      const raw = await fetchSse(`${url}/api/agents/test/stream`, {});
      const parsed = parseSse(raw);
      const endEvt = parsed.events.find((e) => e.type === 'TOOL_CALL_END');
      expect(endEvt).toBeDefined();
      expect(endEvt!.result).toEqual({ answer: 42 });
    } finally {
      await close();
    }
  });
});
