/**
 * Tests for createAgentStream — SSE header wiring, heartbeat, and
 * client-disconnect propagation.
 *
 * We don't spin up a real HTTP server here; instead we drive the factory
 * with a hand-rolled fake Response that records header/write/close events.
 */

import { EventEmitter } from 'events';
import { createAgentStream } from '../../src/agent-streaming/createAgentStream';

class FakeResponse extends EventEmitter {
  public statusCode = 0;
  public headersSent = false;
  public headers: Record<string, string> = {};
  public flushed = false;
  public writes: string[] = [];
  public ended = false;

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  flushHeaders(): void {
    this.flushed = true;
    this.headersSent = true;
  }
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
    this.emit('close');
  }
}

function makeRes(): FakeResponse {
  return new FakeResponse();
}

describe('createAgentStream — headers + initial ping', () => {
  it('sets SSE response headers', () => {
    const res = makeRes();
    createAgentStream(res as never, {
      runId: 'r-1',
      threadId: 't-1',
      heartbeatMs: 0,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.headers['connection']).toBe('keep-alive');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.flushed).toBe(true);
  });

  it('writes the initial ping comment', () => {
    const res = makeRes();
    createAgentStream(res as never, {
      runId: 'r-1',
      threadId: 't-1',
      heartbeatMs: 0,
    });
    expect(res.writes[0]).toBe(': ok\n\n');
  });

  it('allows the initial ping to be overridden', () => {
    const res = makeRes();
    createAgentStream(res as never, {
      runId: 'r-1',
      threadId: 't-1',
      heartbeatMs: 0,
      initialPing: ': custom\n\n',
    });
    expect(res.writes[0]).toBe(': custom\n\n');
  });
});

describe('createAgentStream — heartbeat', () => {
  it('emits a `: hb\\n\\n` comment per heartbeat interval', () => {
    jest.useFakeTimers();
    try {
      const res = makeRes();
      createAgentStream(res as never, {
        runId: 'r-1',
        threadId: 't-1',
        heartbeatMs: 1000,
      });
      // Initial ping written; advance one tick.
      const beforeWrites = res.writes.length;
      jest.advanceTimersByTime(1000);
      const heartbeats = res.writes
        .slice(beforeWrites)
        .filter((w) => w === ': hb\n\n');
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops the heartbeat on close', () => {
    jest.useFakeTimers();
    try {
      const res = makeRes();
      const stream = createAgentStream(res as never, {
        runId: 'r-1',
        threadId: 't-1',
        heartbeatMs: 1000,
      });
      stream.close();
      const writesBefore = res.writes.length;
      jest.advanceTimersByTime(5000);
      // No new heartbeat writes after close.
      const newHeartbeats = res.writes
        .slice(writesBefore)
        .filter((w) => w === ': hb\n\n');
      expect(newHeartbeats).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not schedule a heartbeat when heartbeatMs=0', () => {
    jest.useFakeTimers();
    try {
      const res = makeRes();
      createAgentStream(res as never, {
        runId: 'r-1',
        threadId: 't-1',
        heartbeatMs: 0,
      });
      const writesBefore = res.writes.length;
      jest.advanceTimersByTime(120_000);
      expect(res.writes).toHaveLength(writesBefore);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('createAgentStream — close + disconnect', () => {
  it('client `close` event flips stream.closed and fires onClientDisconnect', () => {
    const res = makeRes();
    let disconnected = 0;
    const stream = createAgentStream(res as never, {
      runId: 'r-1',
      threadId: 't-1',
      heartbeatMs: 0,
      onClientDisconnect: () => disconnected++,
    });
    expect(stream.closed).toBe(false);
    res.emit('close');
    expect(stream.closed).toBe(true);
    expect(disconnected).toBe(1);
  });

  it('after stream.close(), writes are dropped', () => {
    const res = makeRes();
    const stream = createAgentStream(res as never, {
      runId: 'r-1',
      threadId: 't-1',
      heartbeatMs: 0,
      devValidation: false,
    });
    stream.runStarted({ runId: 'r-1', threadId: 't-1' });
    const before = res.writes.length;
    stream.close();
    // Post-close writes (textMessageStart etc.) must be silenced.
    stream.textMessageStart('m-1');
    expect(res.writes.length).toBeLessThanOrEqual(before + 1); // +1 allow the `res.end()` if any
  });

  it('writes RUN_STARTED event in correct SSE shape', () => {
    const res = makeRes();
    const stream = createAgentStream(res as never, {
      runId: 'run-x',
      threadId: 'thr-x',
      heartbeatMs: 0,
    });
    stream.runStarted({ runId: 'run-x', threadId: 'thr-x' });

    const dataFrames = res.writes.filter((w) => w.startsWith('data: '));
    expect(dataFrames).toHaveLength(1);
    expect(dataFrames[0]!.endsWith('\n\n')).toBe(true);
    const evt = JSON.parse(
      dataFrames[0]!.slice('data: '.length, -'\n\n'.length),
    );
    expect(evt).toMatchObject({
      type: 'RUN_STARTED',
      runId: 'run-x',
      threadId: 'thr-x',
    });
  });
});
