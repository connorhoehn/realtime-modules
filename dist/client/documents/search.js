"use strict";
// realtime-modules/src/client/documents/search.ts
//
// platform-api `GET /api/document-search` (realtime-examples NFR #230): the
// Documents page's ranked, paged search over the documents the viewer may
// read (`document:read`). Title > summary > body, recency breaks ties.
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeDocumentSearchItem = normalizeDocumentSearchItem;
exports.normalizeDocumentSearchPage = normalizeDocumentSearchPage;
exports.documentSearchUrl = documentSearchUrl;
exports.fetchDocumentSearch = fetchDocumentSearch;
const KINDS = new Set(['page', 'presentation', 'diagram']);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' && v ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const arr = (v) => (Array.isArray(v) ? v : []);
function normalizeDocumentSearchItem(raw) {
    const r = obj(raw);
    const id = str(r.id);
    if (!id)
        return null;
    const kind = str(r.kind);
    const match = str(r.match);
    return {
        id,
        title: str(r.title) ?? 'Untitled',
        kind: kind && KINDS.has(kind) ? kind : 'page',
        type: str(r.type) ?? '',
        summary: str(r.summary),
        folderId: str(r.folderId),
        folderName: str(r.folderName),
        ownerId: str(r.ownerId),
        ownerName: str(r.ownerName),
        updatedAt: str(r.updatedAt),
        ...(match === 'title' || match === 'summary' || match === 'body' ? { match } : {}),
    };
}
function normalizeDocumentSearchPage(raw) {
    const r = obj(raw);
    const f = obj(r.facets);
    const sort = str(r.sort);
    return {
        query: str(r.query) ?? '',
        sort: sort === 'updated' || sort === 'name' ? sort : 'relevance',
        total: num(r.total),
        libraryTotal: num(r.libraryTotal),
        items: arr(r.items).map(normalizeDocumentSearchItem).filter((i) => i !== null),
        nextCursor: str(r.nextCursor),
        facets: {
            kinds: arr(f.kinds).map(obj).filter((k) => KINDS.has(String(k.kind))).map((k) => ({ kind: k.kind, count: num(k.count) })),
            owners: arr(f.owners).map(obj).filter((o) => str(o.id)).map((o) => ({ id: String(o.id), name: str(o.name) ?? String(o.id), count: num(o.count) })),
            folders: arr(f.folders).map(obj).filter((o) => str(o.id)).map((o) => ({ id: String(o.id), name: str(o.name) ?? '', parentFolderId: str(o.parentFolderId), count: num(o.count) })),
        },
    };
}
function documentSearchUrl(apiBaseUrl, query) {
    const p = new URLSearchParams();
    if (query.q.trim())
        p.set('q', query.q.trim());
    if (query.sort)
        p.set('sort', query.sort);
    const f = query.filters ?? {};
    if (f.kind?.length)
        p.set('kind', f.kind.join(','));
    if (f.owner?.length)
        p.set('owner', f.owner.join(','));
    if (f.folder)
        p.set('folder', f.folder);
    if (typeof f.since === 'number')
        p.set('since', String(f.since));
    if (query.limit)
        p.set('limit', String(query.limit));
    if (query.cursor)
        p.set('cursor', query.cursor);
    if (query.fresh)
        p.set('fresh', '1');
    const qs = p.toString();
    return `${apiBaseUrl}/api/document-search${qs ? `?${qs}` : ''}`;
}
/** `GET /api/document-search`. */
async function fetchDocumentSearch(apiBaseUrl, idToken, query, init) {
    const res = await fetch(documentSearchUrl(apiBaseUrl, query), {
        headers: idToken ? { Authorization: `Bearer ${idToken}` } : {},
        ...(init?.signal ? { signal: init.signal } : {}),
    });
    if (!res.ok) {
        const body = obj(await res.json().catch(() => ({})));
        throw Object.assign(new Error(str(body.message) ?? str(body.error) ?? `Search failed (${res.status})`), { status: res.status });
    }
    return normalizeDocumentSearchPage(await res.json());
}
//# sourceMappingURL=search.js.map