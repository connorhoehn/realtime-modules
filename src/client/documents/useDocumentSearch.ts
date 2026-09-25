// realtime-modules/src/client/documents/useDocumentSearch.ts
//
// The Documents page's search box, on the server (realtime-examples NFR #230):
//   - the words are debounced (`debounceMs`, default 200); sort and filters
//     apply at once;
//   - every new request aborts the one in flight, so a slow answer for "re"
//     can never overwrite the answer for "release";
//   - `loadMore()` appends the next page by cursor;
//   - `refreshKey` re-reads the first page (a host bumps it when a document
//     is created, renamed or deleted), keeping the rows on screen meanwhile;
//     that read and `refresh()` ask the server to skip its row cache
//     (`fresh=1`), so the new document is in the answer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchDocumentSearch } from './search';
import type {
  DocumentSearchFacets,
  DocumentSearchFilters,
  DocumentSearchItem,
  DocumentSearchSort,
} from './search';

export interface UseDocumentSearchOptions {
  /** platform-api origin, e.g. `http://localhost:3001`. */
  apiBaseUrl: string;
  /** Bearer; `null` leaves the hook idle. */
  idToken: string | null;
  query: string;
  /** Default: `relevance` with words, `updated` without. */
  sort?: DocumentSearchSort;
  filters?: DocumentSearchFilters;
  /** Page size. Default 30. */
  limit?: number;
  debounceMs?: number;
  /** Change it to re-read the first page. */
  refreshKey?: unknown;
  enabled?: boolean;
}

export interface UseDocumentSearchResult {
  items: readonly DocumentSearchItem[];
  /** Matches across all pages. */
  total: number;
  /** Documents the viewer may read at all. */
  libraryTotal: number;
  facets: DocumentSearchFacets;
  /** The words the shown rows answer (lags `query` by the debounce). */
  settledQuery: string;
  loading: boolean;
  loadingMore: boolean;
  error?: string;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

const NO_FACETS: DocumentSearchFacets = { kinds: [], owners: [], folders: [] };

export function useDocumentSearch(opts: UseDocumentSearchOptions): UseDocumentSearchResult {
  const { apiBaseUrl, idToken, query, sort, limit = 30, debounceMs = 200, refreshKey } = opts;
  const enabled = opts.enabled !== false && !!idToken;
  const filtersKey = JSON.stringify(opts.filters ?? {});
  const filters = useMemo(() => JSON.parse(filtersKey) as DocumentSearchFilters, [filtersKey]);

  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    if (query.trim() === debounced.trim()) { setDebounced(query); return; }
    const t = setTimeout(() => setDebounced(query), query.trim() ? debounceMs : 0);
    return () => clearTimeout(t);
  }, [query, debounceMs, debounced]);

  const [items, setItems] = useState<readonly DocumentSearchItem[]>([]);
  const [total, setTotal] = useState(0);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [facets, setFacets] = useState<DocumentSearchFacets>(NO_FACETS);
  const [settledQuery, setSettledQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const inflight = useRef<AbortController | null>(null);
  const request = useRef({ q: '', sort, filters, limit });
  const lastRefresh = useRef<{ key: unknown; tick: number } | null>(null);

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    inflight.current?.abort();
    const ctl = new AbortController();
    inflight.current = ctl;
    request.current = { q: debounced, sort, filters, limit };
    const prev = lastRefresh.current;
    const fresh = !!prev && (prev.key !== refreshKey || prev.tick !== tick);
    lastRefresh.current = { key: refreshKey, tick };
    setLoading(true);
    fetchDocumentSearch(apiBaseUrl, idToken, { q: debounced, ...(sort ? { sort } : {}), filters, limit, ...(fresh ? { fresh } : {}) }, { signal: ctl.signal })
      .then((page) => {
        if (ctl.signal.aborted) return;
        setItems(page.items);
        setTotal(page.total);
        setLibraryTotal(page.libraryTotal);
        setFacets(page.facets);
        setCursor(page.nextCursor);
        setSettledQuery(debounced);
        setError(undefined);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => ctl.abort();
  }, [enabled, apiBaseUrl, idToken, debounced, sort, filters, limit, refreshKey, tick]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore || !enabled) return;
    const ctl = new AbortController();
    const at = request.current;
    setLoadingMore(true);
    fetchDocumentSearch(apiBaseUrl, idToken, { q: at.q, ...(at.sort ? { sort: at.sort } : {}), filters: at.filters, limit: at.limit, cursor }, { signal: ctl.signal })
      .then((page) => {
        if (request.current !== at) return; // the query moved on
        setItems((prev) => {
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
        });
        setCursor(page.nextCursor);
        setTotal(page.total);
      })
      .catch((err: unknown) => { if (request.current === at) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => setLoadingMore(false));
  }, [apiBaseUrl, idToken, cursor, loadingMore, enabled]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return { items, total, libraryTotal, facets, settledQuery, loading, loadingMore, error, hasMore: !!cursor, loadMore, refresh };
}
