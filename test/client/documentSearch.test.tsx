/**
 * @jest-environment jsdom
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { documentSearchUrl, normalizeDocumentSearchPage, useDocumentSearch } from '../../src/client/documents';

const page = (ids: string[], next: string | null = null) => ({
  query: '', sort: 'relevance', total: 3, libraryTotal: 9, nextCursor: next,
  items: ids.map((id) => ({ id, title: id.toUpperCase(), kind: 'page', summary: null })),
  facets: { kinds: [{ kind: 'page', count: 9 }], owners: [], folders: [] },
});

afterEach(() => { jest.useRealTimers(); (globalThis as { fetch?: unknown }).fetch = undefined; });

describe('document search client', () => {
  it('builds the query string and normalizes a page', () => {
    expect(documentSearchUrl('http://api', { q: ' release ', sort: 'name', filters: { kind: ['page', 'diagram'], folder: 'f1' }, limit: 30 }))
      .toBe('http://api/api/document-search?q=release&sort=name&kind=page%2Cdiagram&folder=f1&limit=30');
    const p = normalizeDocumentSearchPage({ items: [{ id: 'a', kind: 'bogus' }, { nope: 1 }], total: 1 });
    expect(p.items).toEqual([expect.objectContaining({ id: 'a', kind: 'page', title: 'Untitled' })]);
  });

  it('debounces the words, aborts the stale request and appends pages', async () => {
    const calls: Array<{ url: string; signal?: AbortSignal }> = [];
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: unknown, init?: { signal?: AbortSignal }) => {
      calls.push({ url: String(url), signal: init?.signal });
      if (String(url).includes('q=slow')) await new Promise((r) => setTimeout(r, 100));
      const next = String(url).includes('cursor=') ? null : 'c1';
      const ids = String(url).includes('cursor=') ? ['c'] : ['a', 'b'];
      return { ok: true, status: 200, json: async () => page(ids, next) } as unknown as Response;
    });
    const { result, rerender } = renderHook((p: { q: string }) => useDocumentSearch({ apiBaseUrl: 'http://api', idToken: 't', query: p.q, debounceMs: 20 }), { initialProps: { q: '' } });
    await waitFor(() => expect(result.current.items.length).toBe(2));
    rerender({ q: 'r' });
    rerender({ q: 're' });
    rerender({ q: 'rel' });
    await waitFor(() => expect(result.current.settledQuery).toBe('rel'));
    expect(calls.filter((c) => c.url.includes('q=r')).map((c) => c.url)).toEqual(['http://api/api/document-search?q=rel&limit=30']);
    expect(result.current.libraryTotal).toBe(9);
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b', 'c']));
    expect(result.current.hasMore).toBe(false);
    rerender({ q: 'slow' });
    await waitFor(() => expect(calls.some((c) => c.url.includes('q=slow'))).toBe(true));
    rerender({ q: 'fast' });
    await waitFor(() => expect(result.current.settledQuery).toBe('fast'));
    expect(calls.find((c) => c.url.includes('q=slow'))!.signal!.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 120));
    expect(result.current.settledQuery).toBe('fast');
  });
});
