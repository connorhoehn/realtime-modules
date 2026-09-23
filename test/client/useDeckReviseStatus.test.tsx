/**
 * @jest-environment jsdom
 */
// The live "Generating…" signal for a presentation: platform-api's
// deck:revise events, delivered as pipeline:event frames on the document's
// channel, folded per request.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import {
  useDeckReviseStatus,
  reduceDeckReviseFrame,
  markStaleDeckRevises,
  deckReviseChannel,
} from '../../src/client/useDeckReviseStatus';
import type { PipelineRunTransport } from '../../src/client/pipelines';

const DOC = 'doc-1';

function makeTransport() {
  const handlers = new Set<(frame: unknown) => void>();
  const send = jest.fn();
  const transport: PipelineRunTransport = {
    send,
    onMessage: (fn) => { handlers.add(fn); return () => { handlers.delete(fn); }; },
  };
  const emit = (kind: string, payload: Record<string, unknown>) => {
    act(() => { for (const h of handlers) h({ type: 'pipeline:event', eventType: `pipeline.deck.revise.${kind}`, channel: deckReviseChannel(DOC), payload: { runId: `deck-revise:${DOC}`, documentId: DOC, userId: 'dev-frank', ...payload } }); });
  };
  return { transport, send, emit, handlers };
}

const at = (ms: number) => new Date(ms).toISOString();

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('useDeckReviseStatus', () => {
  it('subscribes to the document channel, and unsubscribes on unmount', () => {
    const { transport, send, handlers } = makeTransport();
    const { unmount } = renderHook(() => useDeckReviseStatus(DOC, { transport }));
    expect(send).toHaveBeenCalledWith({ service: 'pipeline', action: 'subscribe', channel: 'pipeline:run:deck-revise:doc-1' });
    unmount();
    expect(send).toHaveBeenLastCalledWith({ service: 'pipeline', action: 'unsubscribe', channel: 'pipeline:run:deck-revise:doc-1' });
    expect(handlers.size).toBe(0);
  });

  it('marks the slide generating from started until completed, with each phase labelled', () => {
    const { transport, emit } = makeTransport();
    const { result } = renderHook(() => useDeckReviseStatus(DOC, { transport, now: () => 1000 }));
    emit('started', { requestId: 'r1', scope: 'slide', slideId: 'risks', target: { field: 'bullets', index: 2 }, phase: 'started', occurredAt: at(1000) });
    expect(result.current.generatingSlideIds).toEqual(['risks']);
    expect(result.current.isGenerating).toBe(true);
    expect(result.current.active[0]).toMatchObject({ requestId: 'r1', phase: 'started', label: 'Starting', target: { field: 'bullets', index: 2 } });

    emit('phase', { requestId: 'r1', phase: 'asking-model', occurredAt: at(2000) });
    expect(result.current.active[0]).toMatchObject({ phase: 'asking-model', label: 'Writing the edit', slideId: 'risks', startedAt: 1000, updatedAt: 2000 });

    emit('completed', { requestId: 'r1', phase: 'completed', changedSlideIds: ['risks'], occurredAt: at(3000) });
    expect(result.current.generatingSlideIds).toEqual([]);
    expect(result.current.isGenerating).toBe(false);
    expect(result.current.recent[0]).toMatchObject({ phase: 'completed', label: 'Done', changedSlideIds: ['risks'] });
    expect(result.current.get('r1')?.phase).toBe('completed');
  });

  it('a deck-wide revise is generating without naming a slide; a failure carries its status and sentence', () => {
    const { transport, emit } = makeTransport();
    const { result } = renderHook(() => useDeckReviseStatus(DOC, { transport }));
    emit('started', { requestId: 'r2', scope: 'deck', phase: 'started' });
    expect(result.current.isGenerating).toBe(true);
    expect(result.current.generatingSlideIds).toEqual([]);
    emit('failed', { requestId: 'r2', phase: 'failed', status: 503, reason: 'The agent could not answer, so nothing was changed.' });
    expect(result.current.latest).toMatchObject({ phase: 'failed', status: 503, reason: expect.stringContaining('could not answer') });
    expect(result.current.isGenerating).toBe(false);
  });

  it('ignores other documents, other event types and a phase after the end', () => {
    const { transport, emit, handlers } = makeTransport();
    const { result } = renderHook(() => useDeckReviseStatus(DOC, { transport }));
    act(() => { for (const h of handlers) h({ type: 'pipeline:event', eventType: 'pipeline.deck.revise.started', payload: { documentId: 'other', requestId: 'x', phase: 'started' } }); });
    act(() => { for (const h of handlers) h({ type: 'pipeline:event', eventType: 'pipeline.run.started', payload: { documentId: DOC, requestId: 'y' } }); });
    expect(result.current.latest).toBeUndefined();
    emit('started', { requestId: 'r3', scope: 'slide', slideId: 'a', phase: 'started' });
    emit('completed', { requestId: 'r3', phase: 'completed', changedSlideIds: [] });
    emit('phase', { requestId: 'r3', phase: 'checking' });
    expect(result.current.get('r3')?.phase).toBe('completed');
  });

  it('goes stale when no terminal event arrives, and stops counting as generating', () => {
    let clock = 10_000;
    const { transport, emit } = makeTransport();
    const { result } = renderHook(() => useDeckReviseStatus(DOC, { transport, staleMs: 60_000, now: () => clock }));
    emit('started', { requestId: 'r4', scope: 'slide', slideId: 'b', phase: 'started', occurredAt: at(10_000) });
    expect(result.current.generatingSlideIds).toEqual(['b']);
    clock = 75_000;
    act(() => { jest.advanceTimersByTime(5_000); });
    expect(result.current.generatingSlideIds).toEqual([]);
    expect(result.current.recent[0]).toMatchObject({ requestId: 'r4', stale: true, phase: 'started' });
  });

  it('sends nothing with no document or a null transport', () => {
    const { transport, send } = makeTransport();
    renderHook(() => useDeckReviseStatus(null, { transport }));
    renderHook(() => useDeckReviseStatus(DOC, { transport: null }));
    expect(send).not.toHaveBeenCalled();
  });
});

describe('reducers', () => {
  it('reduceDeckReviseFrame returns the same map for a frame it does not own', () => {
    const state = {};
    expect(reduceDeckReviseFrame(state, { type: 'chat' }, DOC, 0)).toBe(state);
    expect(reduceDeckReviseFrame(state, { type: 'pipeline:event', eventType: 'pipeline.deck.revise.phase', payload: { documentId: DOC, requestId: 'r', phase: 'bogus' } }, DOC, 0)).toBe(state);
  });

  it('markStaleDeckRevises leaves settled and fresh revises alone', () => {
    const fresh = reduceDeckReviseFrame({}, { type: 'pipeline:event', eventType: 'pipeline:deck:revise:started', payload: { documentId: DOC, requestId: 'r', phase: 'started' } }, DOC, 100);
    expect(fresh.r?.phase).toBe('started');
    expect(markStaleDeckRevises(fresh, 150, 60_000)).toBe(fresh);
    expect(markStaleDeckRevises(fresh, 100 + 60_000, 60_000).r?.stale).toBe(true);
  });
});
