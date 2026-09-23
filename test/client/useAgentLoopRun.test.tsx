/**
 * @jest-environment jsdom
 */
// One agent loop for a task card: the platform's view, re-read when the run's
// pipeline frames arrive, with Stop and an honest "no pause".

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAgentLoopRun, agentLoopPhase, agentLoopProgress } from '../../src/client/useAgentLoopRun';
import type { PipelineRunTransport } from '../../src/client/pipelines';

const API = 'http://api.test';

function makeTransport() {
  const handlers = new Set<(frame: unknown) => void>();
  const send = jest.fn();
  const transport: PipelineRunTransport = {
    send,
    onMessage: (fn) => { handlers.add(fn); return () => { handlers.delete(fn); }; },
  };
  const emit = (eventType: string, payload: Record<string, unknown>) => {
    act(() => { for (const h of handlers) h({ type: 'pipeline:event', eventType, payload }); });
  };
  return { transport, send, emit };
}

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

function view(over: Record<string, unknown> = {}) {
  return {
    runId: 'loop-1', executorRunId: 'exec-1', pipelineId: 'chat-agent-loop', status: 'running', startedAt: '2026-09-22T10:00:00.000Z',
    steps: [
      { id: 's1', title: 'Gather', status: 'completed' },
      { id: 's2', title: 'Draft', status: 'running' },
      { id: 's3', title: 'Render', status: 'pending' },
      { id: 's4', title: 'Publish', status: 'pending' },
    ],
    controls: { stop: true, pause: false, resume: false, pauseUnsupportedReason: 'Pausing is not supported: engine says no.' },
    ...over,
  };
}

let fetchMock: jest.Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

beforeEach(() => {
  fetchMock = jest.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});
afterEach(() => { jest.useRealTimers(); });

describe('useAgentLoopRun', () => {
  it('reads the loop, reports phase, the step in hand and steps done — and never offers pause', async () => {
    fetchMock.mockResolvedValue(json(view()));
    const { transport } = makeTransport();
    const { result } = renderHook(() => useAgentLoopRun('loop-1', { apiBaseUrl: API, idToken: 't', transport, pollMs: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api.test/api/agent-loops/loop-1');
    expect(result.current).toMatchObject({
      phase: 'running', status: 'running', stepsDone: 1, stepsTotal: 4, percent: 25,
      currentStep: { id: 's2' }, startedAt: '2026-09-22T10:00:00.000Z',
      canStop: true, canPause: false, pauseUnsupportedReason: 'Pausing is not supported: engine says no.',
    });
    expect('pause' in result.current).toBe(false);
  });

  it('subscribes to the executor run channel and re-reads when a frame for the run arrives', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json(view()));
    const { transport, send, emit } = makeTransport();
    const { result } = renderHook(() => useAgentLoopRun('loop-1', { apiBaseUrl: API, idToken: 't', transport, pollMs: 0, frameDebounceMs: 100 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(send).toHaveBeenCalledWith({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:run:exec-1' });

    fetchMock.mockResolvedValueOnce(json(view({ status: 'completed', steps: view().steps.map((s) => ({ ...s, status: 'completed' })) })));
    emit('pipeline.run.completed', { runId: 'someone-else' });
    emit('pipeline.run.completed', { runId: 'exec-1' });
    emit('pipeline.step.completed', { runId: 'exec-1' });
    await act(async () => { jest.advanceTimersByTime(150); });
    await waitFor(() => expect(result.current.phase).toBe('completed'));
    // Two frames for the run inside the debounce → one re-read.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ percent: 100, canStop: false });
  });

  it('Stop posts to the loop and re-reads; a refusal comes back with its reason', async () => {
    fetchMock.mockResolvedValueOnce(json(view()));
    const { result } = renderHook(() => useAgentLoopRun('loop-1', { apiBaseUrl: API, idToken: 't', transport: null, pollMs: 0 }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockResolvedValueOnce(json({ stopped: true }, 202));
    fetchMock.mockResolvedValueOnce(json(view({ status: 'cancelled' })));
    let outcome: unknown;
    await act(async () => { outcome = await result.current.stop(); });
    expect(outcome).toEqual({ ok: true, status: 202 });
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('http://api.test/api/agent-loops/loop-1/stop');
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer t' } });
    await waitFor(() => expect(result.current.phase).toBe('cancelled'));
    expect(result.current.canStop).toBe(false);

    fetchMock.mockResolvedValueOnce(json({ error: 'agent loop not found' }, 404));
    fetchMock.mockResolvedValue(json(view({ status: 'cancelled' })));
    await act(async () => { outcome = await result.current.stop(); });
    expect(outcome).toEqual({ ok: false, status: 404, error: 'agent loop not found' });
  });

  it('says notFound on a 404 and polls only while the loop is live', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue(json({ error: 'agent loop not found' }, 404));
    const { result } = renderHook(() => useAgentLoopRun('nope', { apiBaseUrl: API, idToken: 't', transport: null, pollMs: 1000 }));
    await waitFor(() => expect(result.current.notFound).toBe(true));
    await act(async () => { jest.advanceTimersByTime(5000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads nothing without a run id or a token', () => {
    renderHook(() => useAgentLoopRun(null, { apiBaseUrl: API, idToken: 't', transport: null }));
    renderHook(() => useAgentLoopRun('loop-1', { apiBaseUrl: API, idToken: null, transport: null }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('agentLoopPhase folds the platform status words', () => {
    expect(agentLoopPhase('planning')).toBe('planning');
    expect(agentLoopPhase('canceled')).toBe('cancelled');
    expect(agentLoopPhase('budget')).toBe('budget');
    expect(agentLoopPhase('rejected')).toBe('failed');
    expect(agentLoopPhase(undefined)).toBe('unknown');
  });

  it('agentLoopProgress gives no percent without a plan', () => {
    expect(agentLoopProgress([])).toEqual({ stepsDone: 0, stepsTotal: 0 });
  });
});
