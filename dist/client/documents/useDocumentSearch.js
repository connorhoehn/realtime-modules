"use strict";
// realtime-modules/src/client/documents/useDocumentSearch.ts
//
// The Documents page's search box, on the server (realtime-examples NFR #230):
//   - the words are debounced (`debounceMs`, default 200); sort and filters
//     apply at once;
//   - every new request aborts the one in flight, so a slow answer for "re"
//     can never overwrite the answer for "release";
//   - `loadMore()` appends the next page by cursor;
//   - `refreshKey` re-reads the first page (a host bumps it when a document
//     is created, renamed or deleted), keeping the rows on screen meanwhile.
Object.defineProperty(exports, "__esModule", { value: true });
exports.useDocumentSearch = useDocumentSearch;
const react_1 = require("react");
const search_1 = require("./search");
const NO_FACETS = { kinds: [], owners: [], folders: [] };
function useDocumentSearch(opts) {
    const { apiBaseUrl, idToken, query, sort, limit = 30, debounceMs = 200, refreshKey } = opts;
    const enabled = opts.enabled !== false && !!idToken;
    const filtersKey = JSON.stringify(opts.filters ?? {});
    const filters = (0, react_1.useMemo)(() => JSON.parse(filtersKey), [filtersKey]);
    const [debounced, setDebounced] = (0, react_1.useState)(query);
    (0, react_1.useEffect)(() => {
        if (query.trim() === debounced.trim()) {
            setDebounced(query);
            return;
        }
        const t = setTimeout(() => setDebounced(query), query.trim() ? debounceMs : 0);
        return () => clearTimeout(t);
    }, [query, debounceMs, debounced]);
    const [items, setItems] = (0, react_1.useState)([]);
    const [total, setTotal] = (0, react_1.useState)(0);
    const [libraryTotal, setLibraryTotal] = (0, react_1.useState)(0);
    const [facets, setFacets] = (0, react_1.useState)(NO_FACETS);
    const [settledQuery, setSettledQuery] = (0, react_1.useState)('');
    const [cursor, setCursor] = (0, react_1.useState)(null);
    const [loading, setLoading] = (0, react_1.useState)(true);
    const [loadingMore, setLoadingMore] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)(undefined);
    const [tick, setTick] = (0, react_1.useState)(0);
    const inflight = (0, react_1.useRef)(null);
    const request = (0, react_1.useRef)({ q: '', sort, filters, limit });
    (0, react_1.useEffect)(() => {
        if (!enabled) {
            setLoading(false);
            return;
        }
        inflight.current?.abort();
        const ctl = new AbortController();
        inflight.current = ctl;
        request.current = { q: debounced, sort, filters, limit };
        setLoading(true);
        (0, search_1.fetchDocumentSearch)(apiBaseUrl, idToken, { q: debounced, ...(sort ? { sort } : {}), filters, limit }, { signal: ctl.signal })
            .then((page) => {
            if (ctl.signal.aborted)
                return;
            setItems(page.items);
            setTotal(page.total);
            setLibraryTotal(page.libraryTotal);
            setFacets(page.facets);
            setCursor(page.nextCursor);
            setSettledQuery(debounced);
            setError(undefined);
            setLoading(false);
        })
            .catch((err) => {
            if (ctl.signal.aborted)
                return;
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
        });
        return () => ctl.abort();
    }, [enabled, apiBaseUrl, idToken, debounced, sort, filters, limit, refreshKey, tick]);
    const loadMore = (0, react_1.useCallback)(() => {
        if (!cursor || loadingMore || !enabled)
            return;
        const ctl = new AbortController();
        const at = request.current;
        setLoadingMore(true);
        (0, search_1.fetchDocumentSearch)(apiBaseUrl, idToken, { q: at.q, ...(at.sort ? { sort: at.sort } : {}), filters: at.filters, limit: at.limit, cursor }, { signal: ctl.signal })
            .then((page) => {
            if (request.current !== at)
                return; // the query moved on
            setItems((prev) => {
                const seen = new Set(prev.map((i) => i.id));
                return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
            });
            setCursor(page.nextCursor);
            setTotal(page.total);
        })
            .catch((err) => { if (request.current === at)
            setError(err instanceof Error ? err.message : String(err)); })
            .finally(() => setLoadingMore(false));
    }, [apiBaseUrl, idToken, cursor, loadingMore, enabled]);
    const refresh = (0, react_1.useCallback)(() => setTick((t) => t + 1), []);
    return { items, total, libraryTotal, facets, settledQuery, loading, loadingMore, error, hasMore: !!cursor, loadMore, refresh };
}
//# sourceMappingURL=useDocumentSearch.js.map