/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/usePipelineRunStatus.test.tsx
//
// The run-status hook behind the agent-run cards in a conversation. Two
// sources are merged: `pipeline:event` frames over the socket, and the run
// snapshot from platform-api, polled while the run is not terminal.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { GatewayContext } from '../../src/client/GatewaySocketProvider';
import type { GatewayContextValue } from '../../src/client/GatewaySocketProvider';
import type { GatewayMessage } from '../../src/client/types';
import {
  usePipelineRunStatus,
  statusFromEvent,
  statusFromSnapshot,
  runStatusDetail,
  stepLabelFor,
  DEFAULT_STEP_LABELS,
  approvePipelineRun,
  requestPipelineRun,
} from '../../src/client/pipelines';
import type { PipelineRunTransport } from '../../src/client/pipelines';

const API = 'http://api.test';
const RUN = { runId: 'run-1', pipelineId: 'document-agent-edit' };

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
  return { transport, send, emit, handlers };
}

function snapshotResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

let fetchMock: jest.Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock = jest.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('frame → phase', () => {
  it('walks a document edit: started → step → finishing → completed, with the detail lifted from the apply step', () => {
    let s = statusFromEvent('pipeline.run.started', { runId: 'r' }, undefined, RUN.pipelineId);
    expect(s).toEqual({ phase: 'running' });
    s = statusFromEvent('pipeline.step.started', { stepId: 'read' }, s, RUN.pipelineId);
    expect(s?.stepLabel).toBe(DEFAULT_STEP_LABELS.read);
    s = statusFromEvent('pipeline.step.completed', { stepId: 'apply', output: { applied: 2 } }, s, RUN.pipelineId);
    expect(s).toEqual({ phase: 'running', stepLabel: 'Finishing', detail: '2 changes applied' });
    s = statusFromEvent('pipeline.run.completed', { status: 'completed' }, s, RUN.pipelineId);
    expect(s).toEqual({ phase: 'completed', detail: '2 changes applied' });
  });

  it('pauses for approval with the review reason and names the step a decision goes to', () => {
    const afterReview = statusFromEvent('pipeline.step.completed', { stepId: 'review', output: { needsApproval: true, reason: 'Touches the title' } }, { phase: 'running' });
    expect(afterReview).toEqual({ phase: 'running', stepLabel: 'Waiting for approval', detail: 'Touches the title' });
    const paused = statusFromEvent('pipeline.approval.requested', { stepId: 'approve' }, afterReview);
    expect(paused).toEqual({ phase: 'awaiting_approval', approvalStepId: 'approve', detail: 'Touches the title' });
    // A review that needs no approval says nothing new.
    expect(statusFromEvent('pipeline.step.completed', { stepId: 'review', output: { needsApproval: false } }, { phase: 'running' })).toBeUndefined();
  });

  it('narrates a retry as one, and ignores the first attempt', () => {
    expect(statusFromEvent('pipeline.step.attempt.started', { stepId: 'plan', attemptNumber: 1 }, undefined)).toBeUndefined();
    expect(statusFromEvent('pipeline.step.attempt.started', { stepId: 'plan', attemptNumber: 2, maxAttempts: 3 }, undefined))
      .toEqual({ phase: 'running', stepLabel: `${DEFAULT_STEP_LABELS.plan} · Retrying — attempt 2 of 3` });
    expect(statusFromEvent('pipeline.step.attempt.started', { stepId: 'plan', attemptNumber: 2 }, undefined)?.stepLabel)
      .toBe(`${DEFAULT_STEP_LABELS.plan} · Retrying — attempt 2`);
  });

  it('maps rejection and failure, naming who rejected', () => {
    expect(statusFromEvent('pipeline.run.completed', { status: 'rejected', rejection: { displayName: 'Grace', comment: 'not now' } }, undefined))
      .toEqual({ phase: 'rejected', detail: 'Rejected by Grace — not now' });
    expect(statusFromEvent('pipeline.run.completed', { status: 'rejected', rejection: { userId: 'system:timeout' } }, undefined)?.detail)
      .toBe('Rejected — nobody approved in time');
    expect(statusFromEvent('pipeline.run.failed', { error: 'boom' }, undefined)).toEqual({ phase: 'failed', detail: 'boom' });
    expect(statusFromEvent('pipeline.step.failed', { error: { message: 'step died' } }, undefined)).toEqual({ phase: 'failed', detail: 'step died' });
    expect(statusFromEvent('pipeline.step.failed', {}, undefined)?.detail).toBe('The run failed');
  });

  it('accepts the colon-separated spelling of every event', () => {
    expect(statusFromEvent('pipeline:run:started', {}, undefined)).toEqual({ phase: 'running' });
    expect(statusFromEvent('pipeline:approval:requested', { stepId: 'gate' }, undefined)?.approvalStepId).toBe('gate');
    expect(statusFromEvent('pipeline:run:completed', { status: 'completed' }, undefined)?.phase).toBe('completed');
  });

  it('lifts result from a completed frame, top-level first, then output.result', () => {
    expect(statusFromEvent('pipeline.run.completed', { result: { id: 1 } }, undefined)?.result).toEqual({ id: 1 });
    expect(statusFromEvent('pipeline.run.completed', { output: { result: 'x', steps: {} } }, undefined)?.result).toBe('x');
    expect(statusFromEvent('pipeline.run.completed', {}, undefined)).not.toHaveProperty('result');
  });

  it('ignores frames that are not about a card', () => {
    expect(statusFromEvent('pipeline.step.completed', { stepId: 'plan' }, undefined)).toBeUndefined();
    expect(statusFromEvent('pipeline.something.else', {}, undefined)).toBeUndefined();
    expect(statusFromEvent(undefined, {}, undefined)).toBeUndefined();
  });
});

describe('snapshot → phase', () => {
  it('reads a completed run, with the detail from its steps and the result lifted', () => {
    const withTopLevel = statusFromSnapshot({ status: 'completed', result: { ok: true }, steps: { apply: { status: 'completed', output: { applied: 1 } } } });
    expect(withTopLevel).toEqual({ phase: 'completed', detail: '1 change applied', result: { ok: true } });
    const fromFinalOutput = statusFromSnapshot({ status: 'completed', steps: [{ stepId: 'read', status: 'completed', output: { chars: 9 } }, { stepId: 'publish', status: 'completed', output: { words: 12 } }] });
    expect(fromFinalOutput).toEqual({ phase: 'completed', detail: 'Transcript ready — 12 words', result: { words: 12 } });
    expect(statusFromSnapshot({ status: 'completed' })).toEqual({ phase: 'completed', detail: 'Done' });
  });

  it('reads awaiting_approval from the awaiting step and the review reason', () => {
    const s = statusFromSnapshot({ status: 'awaiting_approval', steps: { review: { status: 'completed', output: { reason: 'Big change' } }, gate: { status: 'awaiting' } } });
    expect(s).toEqual({ phase: 'awaiting_approval', approvalStepId: 'gate', detail: 'Big change' });
    expect(statusFromSnapshot({ status: 'awaiting_approval', context: { reason: 'ctx' } })).toEqual({ phase: 'awaiting_approval', approvalStepId: 'approve', detail: 'ctx' });
  });

  it('narrates the running step and a retry with the budget from the definition', () => {
    const s = statusFromSnapshot({
      status: 'running',
      currentStepIds: ['plan'],
      steps: { plan: { status: 'running', attempts: [{ attemptNumber: 1 }, { attemptNumber: 2 }] } },
      pipelineDefinitionSnapshot: { nodes: [{ id: 'plan', data: { retryPolicy: { maxAttempts: 4 } } }] },
    });
    expect(s?.stepLabel).toBe(`${DEFAULT_STEP_LABELS.plan} · Retrying — attempt 2 of 4`);
    expect(statusFromSnapshot({ status: 'running' }, { phase: 'running', stepLabel: 'kept' })?.stepLabel).toBe('kept');
  });

  it('maps failed/cancelled/rejected and says nothing for pending', () => {
    expect(statusFromSnapshot({ status: 'failed', error: { message: 'nope' } })).toEqual({ phase: 'failed', detail: 'nope' });
    expect(statusFromSnapshot({ status: 'cancelled' })?.phase).toBe('failed');
    expect(statusFromSnapshot({ status: 'rejected', rejection: { userId: 'u-1' } })).toEqual({ phase: 'rejected', detail: 'Rejected by u-1' });
    expect(statusFromSnapshot({ status: 'pending' })).toBeUndefined();
  });
});

describe('labels and detail', () => {
  it('prefers the per-pipeline label, then the general one, then the id', () => {
    expect(stepLabelFor('plan', 'conversation-summarize')).toBe('Writing the summary (Haiku)…');
    expect(stepLabelFor('plan', 'document-agent-edit')).toBe(DEFAULT_STEP_LABELS.plan);
    expect(stepLabelFor('mystery')).toBe('mystery');
    expect(stepLabelFor('plan', undefined, { stepLabels: { plan: 'Thinking' } })).toBe('Thinking');
    expect(stepLabelFor('plan', 'my-pipe', { pipelineStepLabels: { 'my-pipe': { plan: 'Mine' } } })).toBe('Mine');
  });

  it('writes the one line a finished card shows', () => {
    expect(runStatusDetail({ publish: { words: 1 } })).toBe('Transcript ready — 1 word');
    expect(runStatusDetail({ publish: { words: 3, appended: true } })).toBe('Transcript ready — 3 words, added to the document');
    expect(runStatusDetail({ publish: { words: 0 } })).toBe('No speech was found');
    expect(runStatusDetail({ announce: { posted: true } })).toBe('Recording ready');
    expect(runStatusDetail({ apply: { title: 'New name' } })).toBe('Renamed to “New name”');
    expect(runStatusDetail({ apply: { applied: 0, reason: 'Already fine' } })).toBe('Already fine');
    expect(runStatusDetail({ apply: { applied: 0 } })).toBe('No changes were needed');
    expect(runStatusDetail(undefined)).toBeUndefined();
  });
});

describe('usePipelineRunStatus (hook)', () => {
  it('subscribes the firehose and each run, applies frames, and unsubscribes on unmount', () => {
    const { transport, send, emit } = makeTransport();
    const { result, unmount } = renderHook(() => usePipelineRunStatus([RUN], { apiBaseUrl: API, idToken: null, transport }));

    expect(send).toHaveBeenCalledWith({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:all' });
    expect(send).toHaveBeenCalledWith({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:run:run-1' });
    expect(result.current('run-1')).toBeUndefined();

    emit('pipeline.step.started', { runId: 'run-1', stepId: 'read' });
    expect(result.current('run-1')).toEqual({ phase: 'running', stepLabel: DEFAULT_STEP_LABELS.read });

    // A frame about some other run is not ours.
    emit('pipeline.run.failed', { runId: 'run-other', error: 'x' });
    expect(result.current('run-1')?.phase).toBe('running');

    emit('pipeline.approval.requested', { runId: 'run-1', stepId: 'approve' });
    expect(result.current('run-1')).toEqual({ phase: 'awaiting_approval', approvalStepId: 'approve' });

    unmount();
    expect(send).toHaveBeenCalledWith({ service: 'pipeline', action: 'unsubscribe', channel: 'pipeline:run:run-1' });
    // No token: nothing was ever fetched.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('narrates a retry from the attempt frame', () => {
    const { transport, emit } = makeTransport();
    const { result } = renderHook(() => usePipelineRunStatus([RUN], { apiBaseUrl: API, idToken: null, transport }));
    emit('pipeline.step.attempt.started', { runId: 'run-1', stepId: 'plan', attemptNumber: 3, maxAttempts: 3 });
    expect(result.current('run-1')?.stepLabel).toBe(`${DEFAULT_STEP_LABELS.plan} · Retrying — attempt 3 of 3`);
  });

  it('honours stepLabels overrides for frames and snapshots', async () => {
    const { transport, emit } = makeTransport();
    fetchMock.mockResolvedValue(snapshotResponse({ status: 'running', currentStepIds: ['apply'] }));
    const { result } = renderHook(() => usePipelineRunStatus([RUN], {
      apiBaseUrl: API, idToken: 'tok', transport, stepLabels: { read: 'Skimming', apply: 'Landing it' },
    }));
    emit('pipeline.step.started', { runId: 'run-1', stepId: 'read' });
    expect(result.current('run-1')?.stepLabel).toBe('Skimming');
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(result.current('run-1')?.stepLabel).toBe('Landing it'));
  });

  it('polls the snapshot with the bearer while non-terminal and stops at terminal', async () => {
    const { transport } = makeTransport();
    fetchMock
      .mockResolvedValueOnce(snapshotResponse({ status: 'running', currentStepIds: ['read'] }))
      .mockResolvedValueOnce(snapshotResponse({ status: 'running', currentStepIds: ['plan'] }))
      .mockResolvedValue(snapshotResponse({ status: 'completed', result: 'final', steps: { apply: { output: { applied: 1 } } } }));

    const { result } = renderHook(() => usePipelineRunStatus([RUN], { apiBaseUrl: API, idToken: 'tok', transport, pollMs: 500 }));

    // Mount read.
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/api/pipelines/document-agent-edit/runs/run-1`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    await waitFor(() => expect(result.current('run-1')?.stepLabel).toBe(DEFAULT_STEP_LABELS.read));

    // First poll.
    await act(async () => { jest.advanceTimersByTime(500); await Promise.resolve(); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current('run-1')?.stepLabel).toBe(DEFAULT_STEP_LABELS.plan));

    // Second poll lands terminal — with the result lifted.
    await act(async () => { jest.advanceTimersByTime(500); await Promise.resolve(); });
    await waitFor(() => expect(result.current('run-1')?.phase).toBe('completed'));
    expect(result.current('run-1')).toEqual({ phase: 'completed', detail: '1 change applied', result: 'final' });
    const callsAtTerminal = fetchMock.mock.calls.length;

    // Terminal: the clock keeps running, the poll does not.
    await act(async () => { jest.advanceTimersByTime(5000); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(callsAtTerminal);
  });

  it('never lets a late snapshot overwrite a terminal phase learned from a frame', async () => {
    const { transport, emit } = makeTransport();
    let resolveSnap: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((res) => { resolveSnap = res; }));
    const { result } = renderHook(() => usePipelineRunStatus([RUN], { apiBaseUrl: API, idToken: 'tok', transport }));
    emit('pipeline.run.completed', { runId: 'run-1', status: 'completed' });
    expect(result.current('run-1')?.phase).toBe('completed');
    await act(async () => { resolveSnap(snapshotResponse({ status: 'running', currentStepIds: ['read'] })); await Promise.resolve(); });
    expect(result.current('run-1')?.phase).toBe('completed');
  });

  it('falls back to the GatewaySocketProvider context when no transport is given', () => {
    const handlers = new Set<(msg: GatewayMessage) => void>();
    const sendMessage = jest.fn();
    const ctx = {
      connectionState: 'connected', sendMessage,
      onMessage: (h: (msg: GatewayMessage) => void) => { handlers.add(h); return () => handlers.delete(h); },
    } as unknown as GatewayContextValue;
    const wrapper = ({ children }: { children: React.ReactNode }) => <GatewayContext.Provider value={ctx}>{children}</GatewayContext.Provider>;

    const { result } = renderHook(() => usePipelineRunStatus([RUN], { apiBaseUrl: API, idToken: null }), { wrapper });
    expect(sendMessage).toHaveBeenCalledWith({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:run:run-1' });
    act(() => { for (const h of handlers) h({ type: 'pipeline:event', eventType: 'pipeline.run.started', payload: { runId: 'run-1' } }); });
    expect(result.current('run-1')).toEqual({ phase: 'running' });
  });

  it('is inert with no provider and no transport, and with transport: null', () => {
    const { result } = renderHook(() => usePipelineRunStatus([RUN], { apiBaseUrl: API, idToken: null }));
    expect(result.current('run-1')).toBeUndefined();
    const { transport, send } = makeTransport();
    void transport;
    renderHook(() => usePipelineRunStatus([RUN], { apiBaseUrl: API, idToken: null, transport: null }));
    expect(send).not.toHaveBeenCalled();
  });
});

describe('REST helpers', () => {
  it('requestPipelineRun POSTs JSON with the bearer and returns the body', async () => {
    fetchMock.mockResolvedValue(snapshotResponse({ runId: 'r9', pipelineId: 'p' }));
    const out = await requestPipelineRun(API, 'tok', '/api/documents/d1/agent-edit', { instruction: 'tidy' });
    expect(out).toEqual({ runId: 'r9', pipelineId: 'p' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/api/documents/d1/agent-edit`);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init?.body as string)).toEqual({ instruction: 'tidy' });
  });

  it('surfaces the server error message on a non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'no' }) } as unknown as Response);
    await expect(requestPipelineRun(API, 'tok', '/x', {})).rejects.toThrow('no');
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('not json'); } } as unknown as Response);
    await expect(approvePipelineRun(API, 'tok', { runId: 'r', stepId: 's', decision: 'reject' })).rejects.toThrow('Could not reject the run (500)');
  });

  it('approvePipelineRun posts the decision to the run, comment only when given', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => ({}) } as unknown as Response);
    await approvePipelineRun(API, 'tok', { runId: 'run/1', stepId: 'approve', decision: 'approve' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/api/pipelines/run%2F1/approvals`);
    expect(JSON.parse(init?.body as string)).toEqual({ stepId: 'approve', decision: 'approve' });
    await approvePipelineRun(API, null, { runId: 'r', stepId: 's', decision: 'reject', comment: 'later' });
    const [, init2] = fetchMock.mock.calls[1];
    expect(JSON.parse(init2?.body as string)).toEqual({ stepId: 's', decision: 'reject', comment: 'later' });
    expect((init2?.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
