/**
 * @jest-environment jsdom
 */
// A deck's revisions a page at a time, one cache per deck shared by every
// view, and a revision written while open prepended with one GET.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  usePresentationRevisions,
  releasePresentationRevisions,
  PRESENTATION_REVISION_PAGE_SIZE as PAGE,
} from '../../src/client/usePresentationRevisions';
import { deckReviseChannel } from '../../src/client/useDeckReviseStatus';
import type { PipelineRunTransport } from '../../src/client/pipelines';

const API = 'http://platform';
const DOC = 'd';
const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64').replace(/=+$/, '');
const TOKEN = `${b64({ alg: 'none' })}.${b64({ sub: 'dev-frank' })}.x`;

let total = 24;
const summary = (n: number) => ({ id: `v${n}`, label: `v${n}`, createdAt: `2026-09-${String(n).padStart(2, '0')}T00:00:00Z`, createdBy: 'dev-frank', slideCount: 5 });
const slides = (n: number) => [{ id: 'cover', index: 1, title: `Cover v${n}` }];

const fetchImpl = jest.fn(async (input: unknown) => {
  const url = new URL(String(input));
  const single = /\/revisions\/(v\d+)$/.exec(url.pathname);
  if (single) {
    const n = Number(single[1]!.slice(1));
    return { ok: true, status: 200, json: async () => ({ revision: { ...summary(n), slides: slides(n) } }) };
  }
  const limit = Number(url.searchParams.get('limit'));
  const before = url.searchParams.get('before');
  const end = before ? Number(before.slice(1)) - 1 : total;
  const start = Math.max(0, end - limit);
  const page = Array.from({ length: end - start }, (_, i) => end - i).map((n) => (n === total ? { ...summary(n), slides: slides(n) } : summary(n)));
  return { ok: true, status: 200, json: async () => ({ documentId: DOC, title: 'Deck', type: 'presentation', total, revisions: page, nextCursor: start > 0 ? `v${start + 1}` : null }) };
}) as unknown as typeof fetch;
const urls = () => (fetchImpl as unknown as jest.Mock).mock.calls.map(([u]) => String(u));

function makeTransport() {
  const handlers = new Set<(frame: unknown) => void>();
  const transport: PipelineRunTransport = { send: jest.fn(), onMessage: (fn) => { handlers.add(fn); return () => { handlers.delete(fn); }; } };
  const written = (revisionId: string) => act(() => {
    for (const h of handlers) h({ type: 'pipeline:event', eventType: 'pipeline.deck.revise.revision-written', channel: deckReviseChannel(DOC), payload: { documentId: DOC, revisionId } });
  });
  return { transport, written };
}

const opts = (extra: Partial<Parameters<typeof usePresentationRevisions>[0]> = {}) => ({ apiBaseUrl: API, documentId: DOC, idToken: TOKEN, fetchImpl, transport: null, ...extra });

beforeEach(() => { total = 24; releasePresentationRevisions(); (fetchImpl as unknown as jest.Mock).mockClear(); });
afterEach(() => releasePresentationRevisions());

describe('usePresentationRevisions', () => {
  it('reads the newest page oldest-first, then older pages until the history is complete', async () => {
    const { result } = renderHook(() => usePresentationRevisions(opts()));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.total).toBe(24);
    expect(result.current.revisions.map((r) => r.id)).toEqual(Array.from({ length: PAGE }, (_, i) => `v${24 - PAGE + 1 + i}`));
    expect(result.current.revisions.at(-1)!.slides[0]!.title).toBe('Cover v24');
    expect(result.current.revisions[0]!.slidesLoaded).toBe(false);
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.olderCount).toBe(24 - 2 * PAGE));
    expect(urls().at(-1)).toContain(`before=v${24 - PAGE + 1}`);
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.olderCount).toBe(0));
    expect(result.current.revisions.map((r) => r.id)).toEqual(Array.from({ length: 24 }, (_, i) => `v${i + 1}`));
  });

  it('reads a focused older revision alone, without making the pages between look read', async () => {
    const { result } = renderHook(() => usePresentationRevisions(opts({ focusRevisionId: 'v3' })));
    await waitFor(() => expect(result.current.revisions.find((r) => r.id === 'v3')?.slidesLoaded).toBe(true));
    expect(result.current.olderCount).toBe(24 - PAGE);
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.olderCount).toBe(24 - 2 * PAGE));
    expect(urls().at(-1)).toContain(`before=v${24 - PAGE + 1}`);
  });

  it('two views of one deck share one cache: one head read, and an older page read in one is in both', async () => {
    const editor = renderHook(() => usePresentationRevisions(opts()));
    await waitFor(() => expect(editor.result.current.state).toBe('ready'));
    const card = renderHook(() => usePresentationRevisions(opts()));
    expect(card.result.current.state).toBe('ready');
    expect(urls().filter((u) => u.includes('?limit='))).toHaveLength(1);
    act(() => card.result.current.loadOlder());
    await waitFor(() => expect(editor.result.current.olderCount).toBe(24 - 2 * PAGE));
    expect(urls()).toHaveLength(2);
  });

  it('prepends a revision written while open with one GET of that revision', async () => {
    const { transport, written } = makeTransport();
    const { result } = renderHook(() => usePresentationRevisions(opts({ transport })));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    total = 25;
    written('v25');
    await waitFor(() => expect(result.current.total).toBe(25));
    expect(result.current.revisions.at(-1)).toMatchObject({ id: 'v25', slidesLoaded: true });
    expect(result.current.olderCount).toBe(25 - PAGE - 1);
    expect(urls().at(-1)).toBe(`${API}/api/documents/${DOC}/revisions/v25`);
    written('v25');
    await new Promise((r) => setTimeout(r, 10));
    expect(urls()).toHaveLength(2);
  });

  it('a gap (v27 named while the head is v24) re-reads the head page', async () => {
    const { transport, written } = makeTransport();
    const { result } = renderHook(() => usePresentationRevisions(opts({ transport })));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    total = 27;
    written('v27');
    await waitFor(() => expect(result.current.total).toBe(27));
    expect(result.current.revisions.map((r) => r.id).slice(-3)).toEqual(['v25', 'v26', 'v27']);
    expect(result.current.olderCount).toBe(27 - PAGE - 3);
  });

  it('a 404 reads as no-access', async () => {
    const denied = jest.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const { result } = renderHook(() => usePresentationRevisions(opts({ fetchImpl: denied })));
    await waitFor(() => expect(result.current.state).toBe('no-access'));
  });
});
