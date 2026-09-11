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
  reviewPipelineRun,
  reviewDetail,
  isAwaitingReview,
  stepsFromSnapshot,
  opsFromApplyOutput,
  snippetFromOutline,
  documentFromOutputs,
  detailsFromSnapshot,
  enrichTerminalStatus,
} from '../../src/client/pipelines';
import type { PipelineRunStatus } from '../../src/client/pipelines';
import type { PipelineRunRequestError } from '../../src/client/pipelines';
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

/** The status without its `details` — for the exact-shape assertions on the phase and its line. */
function bare(status: PipelineRunStatus | undefined): Omit<PipelineRunStatus, 'details'> | undefined {
  if (!status) return undefined;
  const { details: _details, ...rest } = status;
  return rest;
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
    expect(bare(s)).toEqual({ phase: 'running', stepLabel: 'Finishing', detail: '2 changes applied' });
    s = statusFromEvent('pipeline.run.completed', { status: 'completed' }, s, RUN.pipelineId);
    expect(bare(s)).toEqual({ phase: 'completed', detail: '2 changes applied' });
  });

  it('pauses for approval with the review reason and names the step a decision goes to', () => {
    const afterReview = statusFromEvent('pipeline.step.completed', { stepId: 'review', output: { needsApproval: true, reason: 'Touches the title' } }, { phase: 'running' });
    expect(bare(afterReview)).toEqual({ phase: 'running', stepLabel: 'Waiting for approval', detail: 'Touches the title' });
    const paused = statusFromEvent('pipeline.approval.requested', { stepId: 'approve' }, afterReview);
    expect(bare(paused)).toEqual({ phase: 'awaiting_approval', approvalStepId: 'approve', detail: 'Touches the title' });
    // A review that needs no approval says nothing new about the phase — it only marks its step done in the timeline.
    const noApproval = statusFromEvent('pipeline.step.completed', { stepId: 'review', output: { needsApproval: false } }, { phase: 'running' });
    expect(bare(noApproval)).toEqual({ phase: 'running' });
    expect(noApproval?.details?.steps).toEqual([{ id: 'review', label: 'Checking the plan', status: 'completed' }]);
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
    expect(bare(statusFromEvent('pipeline.run.failed', { error: 'boom' }, undefined))).toEqual({ phase: 'failed', detail: 'boom' });
    expect(bare(statusFromEvent('pipeline.step.failed', { error: { message: 'step died' } }, undefined))).toEqual({ phase: 'failed', detail: 'step died' });
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
    expect(bare(withTopLevel)).toEqual({ phase: 'completed', detail: '1 change applied', result: { ok: true } });
    const fromFinalOutput = statusFromSnapshot({ status: 'completed', steps: [{ stepId: 'read', status: 'completed', output: { chars: 9 } }, { stepId: 'publish', status: 'completed', output: { words: 12 } }] });
    expect(bare(fromFinalOutput)).toEqual({ phase: 'completed', detail: 'Transcript ready — 12 words', result: { words: 12 } });
    expect(statusFromSnapshot({ status: 'completed' })).toEqual({ phase: 'completed', detail: 'Done' });
  });

  it('reads awaiting_approval from the awaiting step and the review reason', () => {
    const s = statusFromSnapshot({ status: 'awaiting_approval', steps: { review: { status: 'completed', output: { reason: 'Big change' } }, gate: { status: 'awaiting' } } });
    expect(bare(s)).toEqual({ phase: 'awaiting_approval', approvalStepId: 'gate', detail: 'Big change' });
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
    expect(bare(statusFromSnapshot({ status: 'failed', error: { message: 'nope' } }))).toEqual({ phase: 'failed', detail: 'nope' });
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
    expect(bare(result.current('run-1'))).toEqual({ phase: 'running', stepLabel: DEFAULT_STEP_LABELS.read });

    // A frame about some other run is not ours.
    emit('pipeline.run.failed', { runId: 'run-other', error: 'x' });
    expect(result.current('run-1')?.phase).toBe('running');

    emit('pipeline.approval.requested', { runId: 'run-1', stepId: 'approve' });
    expect(bare(result.current('run-1'))).toEqual({ phase: 'awaiting_approval', approvalStepId: 'approve' });

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
    expect(bare(result.current('run-1'))).toEqual({ phase: 'completed', detail: '1 change applied', result: 'final' });
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

describe('suggestion reviews', () => {
  const SUGGEST = { mode: 'suggest', suggestionKey: 'grace@bucket-1', applied: 3, ops: [] };
  const REVIEW = { decision: 'accept', suggestionKey: 'grace@bucket-1', documentId: 'doc-1', by: 'u-grace', byName: 'Grace', at: '2026-09-09T00:00:00.000Z' };

  it('a completed suggest run says "N changes suggested" and carries the suggestion, from a frame and from a snapshot', () => {
    // Frames: the apply step carries the suggestion; the completed frame keeps it.
    const running = statusFromEvent('pipeline.step.completed', { stepId: 'apply', output: SUGGEST, documentId: 'doc-1' }, { phase: 'running' }, RUN.pipelineId);
    expect(bare(running)).toEqual({ phase: 'running', stepLabel: 'Finishing', detail: '3 changes suggested', suggestion: { key: 'grace@bucket-1', documentId: 'doc-1', applied: 3 } });
    const done = statusFromEvent('pipeline.run.completed', { status: 'completed' }, running, RUN.pipelineId);
    expect(bare(done)).toEqual({ phase: 'completed', detail: '3 changes suggested', suggestion: { key: 'grace@bucket-1', documentId: 'doc-1', applied: 3 } });
    expect(isAwaitingReview(done)).toBe(true);
    // A completed frame that carries the whole context works on its own too.
    expect(bare(statusFromEvent('pipeline.run.completed', { output: { trigger: { documentId: 'doc-9' }, steps: { apply: { ...SUGGEST, applied: 1 } } } }, undefined))).toEqual({
      phase: 'completed', detail: '1 change suggested', suggestion: { key: 'grace@bucket-1', documentId: 'doc-9', applied: 1 }, result: undefined,
    });
    // Snapshot: documentId from the trigger/context.
    expect(bare(statusFromSnapshot({ status: 'completed', context: { documentId: 'doc-1' }, steps: { apply: { status: 'completed', output: SUGGEST } } }))).toEqual({
      phase: 'completed', detail: '3 changes suggested', suggestion: { key: 'grace@bucket-1', documentId: 'doc-1', applied: 3 }, result: SUGGEST,
    });
    // Applied mode is unchanged.
    expect(runStatusDetail({ apply: { applied: 2 } })).toBe('2 changes applied');
    expect(runStatusDetail({ apply: { ...SUGGEST, applied: 1 } })).toBe('1 change suggested');
  });

  it('the reviewed event settles the card to "Accepted by <name>", falling back to the id, in both spellings', () => {
    const pending = statusFromSnapshot({ status: 'completed', context: { documentId: 'doc-1' }, steps: { apply: { output: SUGGEST } } })!;
    const accepted = statusFromEvent('pipeline.run.reviewed', { runId: 'run-1', ...REVIEW }, pending);
    expect(bare(accepted)).toEqual({
      ...bare(pending),
      detail: 'Accepted by Grace',
      review: { decision: 'accept', by: 'u-grace', byName: 'Grace', at: REVIEW.at },
    });
    expect(isAwaitingReview(accepted)).toBe(false);
    const rejected = statusFromEvent('pipeline:run:reviewed', { ...REVIEW, decision: 'reject', byName: undefined }, pending);
    expect(rejected?.detail).toBe('Rejected by u-grace');
    expect(rejected?.review).toEqual({ decision: 'reject', by: 'u-grace', at: REVIEW.at });
    // A review for a card we had not seen yet still lands as a completed, reviewed run.
    expect(bare(statusFromEvent('pipeline.run.reviewed', REVIEW, undefined))).toEqual({
      phase: 'completed', detail: 'Accepted by Grace', suggestion: { key: 'grace@bucket-1', documentId: 'doc-1', applied: 0 }, review: { decision: 'accept', by: 'u-grace', byName: 'Grace', at: REVIEW.at },
    });
    expect(statusFromEvent('pipeline.run.reviewed', { decision: 'maybe' }, pending)).toBeUndefined();
    expect(reviewDetail({ decision: 'reject', by: 'u-1', at: 'x' })).toBe('Rejected by u-1');
  });

  it('reads the review from a snapshot, and a late snapshot without one keeps the review already known', () => {
    const fromSnap = statusFromSnapshot({ status: 'completed', review: REVIEW, context: { documentId: 'doc-1' }, steps: { apply: { output: SUGGEST } } });
    expect(fromSnap?.detail).toBe('Accepted by Grace');
    expect(fromSnap?.review).toEqual({ decision: 'accept', by: 'u-grace', byName: 'Grace', at: REVIEW.at });
    expect(fromSnap?.suggestion).toEqual({ key: 'grace@bucket-1', documentId: 'doc-1', applied: 3 });
    const late = statusFromSnapshot({ status: 'completed', steps: { apply: { output: SUGGEST } } }, fromSnap);
    expect(late?.review).toEqual(fromSnap?.review);
    expect(late?.detail).toBe('Accepted by Grace');
  });

  it('hook: keeps re-reading a pending suggestion slowly, takes the review from the snapshot, then stops', async () => {
    const { transport } = makeTransport();
    fetchMock
      .mockResolvedValueOnce(snapshotResponse({ status: 'completed', context: { documentId: 'doc-1' }, steps: { apply: { output: SUGGEST } } }))
      .mockResolvedValueOnce(snapshotResponse({ status: 'completed', context: { documentId: 'doc-1' }, steps: { apply: { output: SUGGEST } } }))
      .mockResolvedValue(snapshotResponse({ status: 'completed', review: REVIEW, context: { documentId: 'doc-1' }, steps: { apply: { output: SUGGEST } } }));
    const { result } = renderHook(() => usePipelineRunStatus([RUN], { apiBaseUrl: API, idToken: 'tok', transport, pollMs: 500, reviewPollMs: 2000 }));

    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(result.current('run-1')?.detail).toBe('3 changes suggested'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The fast poll is off (the phase is terminal); the slow review poll is on.
    await act(async () => { jest.advanceTimersByTime(1500); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(500); await Promise.resolve(); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current('run-1')?.review).toBeUndefined();

    await act(async () => { jest.advanceTimersByTime(2000); await Promise.resolve(); });
    await waitFor(() => expect(result.current('run-1')?.detail).toBe('Accepted by Grace'));
    expect(result.current('run-1')?.review?.byName).toBe('Grace');
    const calls = fetchMock.mock.calls.length;

    // Reviewed: settled, no more reads.
    await act(async () => { jest.advanceTimersByTime(10_000); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it('hook: the reviewed frame settles the card and a late snapshot does not clear the review', async () => {
    const { transport, emit } = makeTransport();
    let resolveSnap: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((res) => { resolveSnap = res; }));
    const { result } = renderHook(() => usePipelineRunStatus([RUN], { apiBaseUrl: API, idToken: 'tok', transport }));

    emit('pipeline.step.completed', { runId: 'run-1', stepId: 'apply', output: SUGGEST, documentId: 'doc-1' });
    emit('pipeline.run.completed', { runId: 'run-1', status: 'completed' });
    expect(result.current('run-1')?.detail).toBe('3 changes suggested');
    emit('pipeline:run:reviewed', { runId: 'run-1', ...REVIEW, decision: 'reject' });
    expect(result.current('run-1')?.detail).toBe('Rejected by Grace');

    // The mount read resolves late, without the review — the review stays.
    await act(async () => { resolveSnap(snapshotResponse({ status: 'completed', context: { documentId: 'doc-1' }, steps: { apply: { output: SUGGEST } } })); await Promise.resolve(); });
    expect(result.current('run-1')?.review?.decision).toBe('reject');
    expect(result.current('run-1')?.detail).toBe('Rejected by Grace');
    expect(result.current('run-1')?.suggestion).toEqual({ key: 'grace@bucket-1', documentId: 'doc-1', applied: 3 });

    // Settled: no review polling either.
    await act(async () => { jest.advanceTimersByTime(60_000); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reviewPipelineRun posts the decision to the run, drops undefined fields, and surfaces a 409 with its status', async () => {
    fetchMock.mockResolvedValue(snapshotResponse({ runId: 'run-1', pipelineId: 'document-agent-edit', review: REVIEW }));
    const out = await reviewPipelineRun(API, 'tok', { pipelineId: 'document-agent-edit', runId: 'run/1', decision: 'accept', suggestionKey: 'grace@bucket-1', documentId: 'doc-1', byName: 'Grace' });
    expect(out.review.decision).toBe('accept');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/api/pipelines/document-agent-edit/runs/run%2F1/review`);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init?.body as string)).toEqual({ decision: 'accept', suggestionKey: 'grace@bucket-1', documentId: 'doc-1', byName: 'Grace' });

    await reviewPipelineRun(API, null, { pipelineId: 'p', runId: 'r', decision: 'reject', suggestionKey: 'k', documentId: 'd', comment: 'no', applyServerSide: true });
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({ decision: 'reject', suggestionKey: 'k', documentId: 'd', comment: 'no', applyServerSide: true });

    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'Already reviewed by Grace' }) } as unknown as Response);
    const err = await reviewPipelineRun(API, 'tok', { pipelineId: 'p', runId: 'r', decision: 'accept', suggestionKey: 'k', documentId: 'd' }).catch((e: PipelineRunRequestError) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as PipelineRunRequestError).message).toBe('Already reviewed by Grace');
    expect((err as PipelineRunRequestError).status).toBe(409);
  });
});

describe('details — the expanded card', () => {
  const T = (n: number) => `2026-09-10T00:00:0${n}.000Z`;
  // The attachment macro's text is its YAML body, and it spans lines.
  const OUTLINE = 'title: Roadmap\n#0 heading(h1): Roadmap\n#1 paragraph: First para text.\n#2 macro(attachment): name: brief.txt\nsize: 1520\ntype: text/plain\nurl: https://x/brief.txt\n#3 macro(decision): Ship it\n#4 paragraph: (empty)';
  const SNAP = {
    status: 'running',
    currentStepIds: ['apply'],
    startedAt: T(0),
    context: { documentId: 'doc-1' },
    steps: {
      plan: { status: 'completed', startedAt: T(2), completedAt: T(3), output: { ops: [] } },
      read: { status: 'completed', startedAt: T(1), output: { documentOutline: OUTLINE, documentTitle: 'Roadmap' } },
      trigger: { status: 'completed', startedAt: T(0), output: { documentId: 'doc-1' } },
      apply: { status: 'running', startedAt: T(4) },
      approve: { status: 'skipped' },
    },
  };

  it('orders the steps trigger-first then by startedAt, keeps an unstamped step in place, labels them without the ellipsis', () => {
    const steps = stepsFromSnapshot(SNAP, RUN.pipelineId);
    expect(steps).toEqual([
      { id: 'trigger', label: 'trigger', status: 'completed' },
      { id: 'read', label: 'Reading the document', status: 'completed' },
      { id: 'plan', label: 'Deciding what to change (Haiku)', status: 'completed' },
      { id: 'apply', label: 'Applying the edit as a collaborator', status: 'running' },
      { id: 'approve', label: 'Waiting for approval', status: 'skipped' },
    ]);
    // An in-flight id from `currentStepIds` reads as running even when the record has no status yet; awaiting stays awaiting.
    expect(stepsFromSnapshot({ status: 'running', currentStepIds: ['plan'], steps: { plan: {} } })?.[0].status).toBe('running');
    expect(stepsFromSnapshot({ status: 'awaiting_approval', currentStepIds: ['approve'], steps: { approve: { status: 'awaiting' } } })?.[0].status).toBe('awaiting');
    // No timestamps at all: object order.
    expect(stepsFromSnapshot({ steps: { b: { status: 'completed' }, a: { status: 'failed' } } })?.map((s) => s.id)).toEqual(['b', 'a']);
    expect(stepsFromSnapshot({ steps: {} })).toBeUndefined();
    // Per-pipeline and host labels apply to the timeline too.
    expect(stepsFromSnapshot({ steps: { plan: {} } }, 'conversation-summarize')?.[0].label).toBe('Writing the summary (Haiku)');
    expect(stepsFromSnapshot({ steps: { plan: {} } }, undefined, { stepLabels: { plan: 'Thinking...' } })?.[0].label).toBe('Thinking');
  });

  it('flattens every DocOp kind, truncating text and reason at 140 chars and dropping the YAML', () => {
    const long = 'x'.repeat(200);
    const ops = opsFromApplyOutput({ applied: 7, ops: [
      { op: 'setTitle', text: 'New title' },
      { op: 'appendBlock', kind: 'paragraph', text: long },
      { op: 'insertBlock', index: 2, kind: 'heading', level: 2, text: 'Heading' },
      { op: 'appendBlock', kind: 'horizontalRule' },
      { op: 'appendBlock', kind: '', level: 'two' },
      { op: 'replaceBlock', index: 1, text: 'Replaced' },
      { op: 'deleteBlock', index: 3 },
      { op: 'copyBlock', index: 4 },
      { op: 'appendMacro', macroName: 'decision', yaml: 'title: x\nstatus: open' },
      { op: 'setDocumentType', typeId: 't-1', typeName: 'RFC', icon: 'doc' },
      { op: 'skip', reason: 'Already covered' },
      { notAnOp: true },
      null,
    ] });
    // `kind` and `level` ride along so a card can say "a divider" or "heading …" rather than quote an empty text.
    expect(ops).toEqual([
      { op: 'setTitle', text: 'New title' },
      { op: 'appendBlock', kind: 'paragraph', text: `${'x'.repeat(139)}…` },
      { op: 'insertBlock', index: 2, kind: 'heading', level: 2, text: 'Heading' },
      { op: 'appendBlock', kind: 'horizontalRule' },
      { op: 'appendBlock' },
      { op: 'replaceBlock', index: 1, text: 'Replaced' },
      { op: 'deleteBlock', index: 3 },
      { op: 'copyBlock', index: 4 },
      { op: 'appendMacro', macroName: 'decision' },
      { op: 'setDocumentType', typeName: 'RFC' },
      { op: 'skip', reason: 'Already covered' },
    ]);
    expect(ops?.[1].text).toHaveLength(140);
    expect(opsFromApplyOutput({ applied: 1 })).toBeUndefined();
    expect(opsFromApplyOutput(undefined)).toBeUndefined();
  });

  it('derives the document from the read step (title + outline snippet), or from what apply wrote when there was no read', () => {
    // The level-1 heading repeats the title and a macro's text is its YAML body — neither is a preview.
    expect(snippetFromOutline(OUTLINE)).toBe('First para text.');
    // The lines a macro's YAML body continues onto go with the macro, not into the snippet.
    expect(snippetFromOutline('title: T\n#0 macro(attachment): name: a.txt\nsize: 1520\nurl: https://x/a.txt\n#1 paragraph: After the file.\n#2 paragraph: And more.')).toBe('After the file. And more.');
    expect(snippetFromOutline(`title: T\n#0 paragraph: ${'y'.repeat(300)}`)).toHaveLength(200);
    expect(snippetFromOutline('title: T\n#0 paragraph: (empty)')).toBeUndefined();
    expect(snippetFromOutline(undefined)).toBeUndefined();

    const fromRead = documentFromOutputs({ trigger: { documentId: 'doc-1' }, read: { documentOutline: OUTLINE, documentTitle: 'Roadmap' } });
    expect(fromRead).toEqual({ id: 'doc-1', title: 'Roadmap', snippet: 'First para text.' });

    const fromApply = documentFromOutputs({ apply: { title: 'Fresh page', ops: [{ op: 'setTitle', text: 'Fresh page' }, { op: 'appendBlock', kind: 'paragraph', text: 'Hello world' }] } }, { documentId: 'doc-2' });
    expect(fromApply).toEqual({ id: 'doc-2', title: 'Fresh page', snippet: 'Hello world' });

    // The context's title is the last resort; no id at all means no document.
    expect(documentFromOutputs({}, { documentId: 'doc-3', documentTitle: 'Ctx' })).toEqual({ id: 'doc-3', title: 'Ctx' });
    expect(documentFromOutputs({ read: { documentTitle: 'Orphan' } })).toBeUndefined();

    // The whole snapshot path, timestamps included.
    const details = detailsFromSnapshot(SNAP, undefined, RUN.pipelineId);
    expect(details?.document).toEqual({ id: 'doc-1', title: 'Roadmap', snippet: 'First para text.' });
    expect(details?.startedAt).toBe(T(0));
    expect(details?.steps?.map((s) => s.id)).toEqual(['trigger', 'read', 'plan', 'apply', 'approve']);
    expect(statusFromSnapshot(SNAP, undefined, RUN.pipelineId)?.details).toEqual(details);
  });

  it('step frames move a step in the timeline in place, add one the snapshot had not seen, and keep everything else', () => {
    const start = statusFromSnapshot(SNAP, undefined, RUN.pipelineId)!;
    const s1 = statusFromEvent('pipeline.step.completed', { stepId: 'apply', output: { applied: 1, ops: [{ op: 'setTitle', text: 'T' }] } }, start, RUN.pipelineId)!;
    expect(s1.details?.steps?.find((s) => s.id === 'apply')?.status).toBe('completed');
    expect(s1.details?.ops).toEqual([{ op: 'setTitle', text: 'T' }]);
    expect(s1.details?.document).toEqual(start.details?.document);
    expect(s1.details?.steps).toHaveLength(5);

    const s2 = statusFromEvent('pipeline.step.started', { stepId: 'publish' }, s1, RUN.pipelineId)!;
    expect(s2.details?.steps?.map((s) => `${s.id}:${s.status}`)).toEqual(['trigger:completed', 'read:completed', 'plan:completed', 'apply:completed', 'approve:skipped', 'publish:running']);
    expect(s2.details?.steps?.[5].label).toBe('Publishing the transcript');

    const s3 = statusFromEvent('pipeline.step.failed', { stepId: 'publish', error: { message: 'no channel' } }, s2, RUN.pipelineId)!;
    expect(s3.phase).toBe('failed');
    expect(s3.detail).toBe('no channel');
    expect(s3.details?.error).toBe('no channel');
    expect(s3.details?.steps?.[5].status).toBe('failed');
    expect(s3.details?.ops).toEqual(s1.details?.ops);

    // A frame that says nothing about the phase still moves its step.
    const s4 = statusFromEvent('pipeline.step.completed', { stepId: 'plan', output: {} }, { phase: 'running', details: { steps: [{ id: 'plan', label: 'Plan', status: 'running' }] } })!;
    expect(s4).toEqual({ phase: 'running', details: { steps: [{ id: 'plan', label: 'Plan', status: 'completed' }] } });
    // With no details yet, a step frame starts the timeline.
    expect(statusFromEvent('pipeline.step.started', { stepId: 'read' }, undefined, RUN.pipelineId)?.details?.steps).toEqual([{ id: 'read', label: 'Reading the document', status: 'running' }]);
  });

  it('details survive a sparse snapshot — nothing is ever cleared', () => {
    const rich = statusFromSnapshot(SNAP, undefined, RUN.pipelineId)!;
    const withOps = statusFromEvent('pipeline.step.completed', { stepId: 'apply', output: { applied: 1, ops: [{ op: 'setTitle', text: 'T' }] } }, rich, RUN.pipelineId)!;
    const sparse = statusFromSnapshot({ status: 'completed' }, withOps, RUN.pipelineId)!;
    expect(sparse.phase).toBe('completed');
    expect(sparse.details).toEqual(withOps.details);
    // A later snapshot with a title but no snippet keeps the snippet.
    const partial = statusFromSnapshot({ status: 'completed', context: { documentId: 'doc-1', documentTitle: 'Renamed' } }, withOps, RUN.pipelineId)!;
    expect(partial.details?.document).toEqual({ id: 'doc-1', title: 'Renamed', snippet: 'First para text.' });
    expect(partial.details?.ops).toEqual(withOps.details?.ops);
    expect(partial.details?.steps).toEqual(withOps.details?.steps);
  });

  it('a run that applied nothing is a noop with the model\'s reason as its line, from a snapshot and from frames', () => {
    const snap = statusFromSnapshot({ status: 'completed', steps: { apply: { status: 'completed', output: { applied: 0, skipped: 0, reason: 'Already covered', planText: '...' } } } });
    expect(snap?.detail).toBe('Already covered');
    expect(snap?.noop).toBe(true);
    expect(statusFromSnapshot({ status: 'completed', steps: { apply: { output: { applied: 2 } } } })?.noop).toBeUndefined();

    const finishing = statusFromEvent('pipeline.step.completed', { stepId: 'apply', output: { applied: 0, reason: 'Already covered' } }, { phase: 'running' })!;
    expect(finishing.noop).toBe(true);
    const done = statusFromEvent('pipeline.run.completed', { status: 'completed' }, finishing)!;
    expect(done.phase).toBe('completed');
    expect(done.detail).toBe('Already covered');
    expect(done.noop).toBe(true);
    // A completed frame carrying the context says so on its own.
    expect(statusFromEvent('pipeline.run.completed', { output: { steps: { apply: { applied: 0, reason: 'Nothing to do' } } } }, undefined)).toMatchObject({ phase: 'completed', detail: 'Nothing to do', noop: true });
  });

  it('a failed run carries its error: the run\'s, else the failed step\'s; a completion frame that says failed is a failure', () => {
    const fromStep = statusFromSnapshot({ status: 'failed', steps: { read: { status: 'completed' }, plan: { status: 'failed', error: 'Haiku timed out' } } });
    expect(fromStep?.phase).toBe('failed');
    expect(fromStep?.detail).toBe('Haiku timed out');
    expect(fromStep?.details?.error).toBe('Haiku timed out');
    expect(fromStep?.details?.steps?.map((s) => s.status)).toEqual(['completed', 'failed']);
    const own = statusFromSnapshot({ status: 'failed', error: 'Run-level boom', steps: { plan: { status: 'failed', error: 'step boom' } } });
    expect(own?.detail).toBe('Run-level boom');
    expect(own?.details?.error).toBe('Run-level boom');
    const fromAttempt = statusFromSnapshot({ status: 'failed', steps: { plan: { status: 'failed', attempts: [{ attemptNumber: 1, error: 'first' }, { attemptNumber: 2, error: 'second' }] } } });
    expect(fromAttempt?.detail).toBe('second');
    expect(statusFromSnapshot({ status: 'failed' })?.detail).toBe('The run failed');

    const frame = statusFromEvent('pipeline.run.completed', { status: 'failed', error: { nodeId: 'plan', message: 'boom' } }, { phase: 'running' });
    expect(frame?.phase).toBe('failed');
    expect(frame?.detail).toBe('boom');
    expect(frame?.details?.error).toBe('boom');
    const runFailed = statusFromEvent('pipeline.run.failed', { error: { nodeId: 'plan', message: 'died' }, at: T(5) }, { phase: 'running', details: { steps: [{ id: 'plan', label: 'Plan', status: 'running' }] } });
    expect(runFailed?.details).toEqual({ steps: [{ id: 'plan', label: 'Plan', status: 'failed' }], error: 'died', completedAt: T(5) });
  });

  it('a snapshot fills in a terminal card learned from a frame: placeholder line, noop, result, details — never the phase', () => {
    const doneFromFrame: PipelineRunStatus = { phase: 'completed', detail: 'Done' };
    const skipped = enrichTerminalStatus(doneFromFrame, { status: 'completed', completedAt: T(6), context: { documentId: 'doc-1' }, steps: { apply: { status: 'completed', output: { applied: 0, reason: 'Already covered' } } } });
    expect(skipped).toMatchObject({ phase: 'completed', detail: 'Already covered', noop: true, details: { completedAt: T(6), document: { id: 'doc-1' } } });
    expect(skipped.details?.steps).toEqual([{ id: 'apply', label: 'Applying the edit as a collaborator', status: 'completed' }]);

    const failedFromFrame: PipelineRunStatus = { phase: 'failed', detail: 'The run failed' };
    const failed = enrichTerminalStatus(failedFromFrame, { status: 'failed', steps: { plan: { status: 'failed', error: 'Haiku timed out' } } });
    expect(failed.detail).toBe('Haiku timed out');
    expect(failed.details?.error).toBe('Haiku timed out');

    // A specific line already known is kept; a stale non-terminal snapshot changes nothing but details; identity when nothing changed.
    const specific: PipelineRunStatus = { phase: 'completed', detail: '2 changes applied' };
    expect(enrichTerminalStatus(specific, { status: 'completed', steps: { apply: { output: { applied: 0, reason: 'x' } } } }).detail).toBe('2 changes applied');
    const stale = enrichTerminalStatus(specific, { status: 'running', currentStepIds: ['read'], steps: { read: { status: 'running' } } });
    expect(stale.phase).toBe('completed');
    expect(stale.detail).toBe('2 changes applied');
    expect(stale.details?.steps?.[0]).toEqual({ id: 'read', label: 'Reading the document', status: 'running' });
    expect(enrichTerminalStatus(specific, { status: 'completed' })).toBe(specific);
  });

  it('hook: a failed frame without a message and a skipped run both get their real line from the snapshot', async () => {
    const { transport, emit } = makeTransport();
    let resolveSnap: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((res) => { resolveSnap = res; }));
    const { result } = renderHook(() => usePipelineRunStatus([RUN], { apiBaseUrl: API, idToken: 'tok', transport }));
    emit('pipeline.run.completed', { runId: 'run-1', status: 'completed' });
    expect(result.current('run-1')).toEqual({ phase: 'completed', detail: 'Done' });
    await act(async () => {
      resolveSnap(snapshotResponse({ status: 'completed', context: { documentId: 'doc-1' }, steps: { read: { status: 'completed', output: { documentTitle: 'Roadmap', documentOutline: OUTLINE } }, apply: { status: 'completed', output: { applied: 0, reason: 'Already covered' } } } }));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current('run-1')?.detail).toBe('Already covered'));
    expect(result.current('run-1')?.noop).toBe(true);
    expect(result.current('run-1')?.details?.document).toEqual({ id: 'doc-1', title: 'Roadmap', snippet: 'First para text.' });
    expect(result.current('run-1')?.details?.steps?.map((s) => s.id)).toEqual(['read', 'apply']);

    const RUN2 = { runId: 'run-2', pipelineId: 'document-agent-edit' };
    let resolveSnap2: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((res) => { resolveSnap2 = res; }));
    const second = renderHook(() => usePipelineRunStatus([RUN2], { apiBaseUrl: API, idToken: 'tok', transport }));
    emit('pipeline.run.failed', { runId: 'run-2' });
    expect(second.result.current('run-2')).toEqual({ phase: 'failed', detail: 'The run failed' });
    await act(async () => { resolveSnap2(snapshotResponse({ status: 'failed', error: 'Haiku timed out', steps: { plan: { status: 'failed', error: 'Haiku timed out' } } })); await Promise.resolve(); });
    await waitFor(() => expect(second.result.current('run-2')?.detail).toBe('Haiku timed out'));
    expect(second.result.current('run-2')?.details?.error).toBe('Haiku timed out');
    expect(second.result.current('run-2')?.phase).toBe('failed');
  });
});

describe('noop — only a real skip', () => {
  it('does not flag a transcription whose optional apply step had no document', () => {
    const { statusFromSnapshot } = require('../../src/client/pipelines/usePipelineRunStatus');
    const status = statusFromSnapshot({ status: 'completed', steps: { transcribe: { status: 'completed', output: { words: 12 } }, apply: { status: 'completed', output: { applied: 0, skipped: 'no document on this run' } }, publish: { status: 'completed', output: { posted: true, words: 12 } } } } as never, undefined, {});
    expect(status?.noop).toBeUndefined();
  });
  it('flags a document edit whose plan was a skip', () => {
    const { statusFromSnapshot } = require('../../src/client/pipelines/usePipelineRunStatus');
    const status = statusFromSnapshot({ status: 'completed', steps: { plan: { status: 'completed', output: { text: '[{"op":"skip"}]' } }, apply: { status: 'completed', output: { applied: 0, skipped: 0, reason: 'nothing to do' } } } } as never, undefined, {});
    expect(status?.noop).toBe(true);
  });
});
