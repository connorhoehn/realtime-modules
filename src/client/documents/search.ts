// realtime-modules/src/client/documents/search.ts
//
// platform-api `GET /api/document-search` (realtime-examples NFR #230): the
// Documents page's ranked, paged search over the documents the viewer may
// read (`document:read`). Title > summary > body, recency breaks ties.

export type DocumentSearchKind = 'page' | 'presentation' | 'diagram';
export type DocumentSearchSort = 'relevance' | 'updated' | 'name';
export type DocumentSearchMatch = 'title' | 'summary' | 'body';

export interface DocumentSearchFilters {
  kind?: readonly DocumentSearchKind[];
  owner?: readonly string[];
  /** A folder id (sub-folders included), or `unfiled`. */
  folder?: string | null;
  /** Changed at or after this epoch ms. */
  since?: number | null;
}

export interface DocumentSearchItem {
  id: string;
  title: string;
  kind: DocumentSearchKind;
  /** The row's own type (`page`, `presentation`, a custom type id…). */
  type: string;
  /** The opening sentence of a page, else the description; null when neither. */
  summary: string | null;
  folderId: string | null;
  folderName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  updatedAt: string | null;
  match?: DocumentSearchMatch;
}

export interface DocumentSearchFacets {
  kinds: Array<{ kind: DocumentSearchKind; count: number }>;
  owners: Array<{ id: string; name: string; count: number }>;
  folders: Array<{ id: string; name: string; parentFolderId: string | null; count: number }>;
}

export interface DocumentSearchPage {
  query: string;
  sort: DocumentSearchSort;
  total: number;
  libraryTotal: number;
  items: DocumentSearchItem[];
  nextCursor: string | null;
  facets: DocumentSearchFacets;
}

const KINDS = new Set<string>(['page', 'presentation', 'diagram']);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function normalizeDocumentSearchItem(raw: unknown): DocumentSearchItem | null {
  const r = obj(raw);
  const id = str(r.id);
  if (!id) return null;
  const kind = str(r.kind);
  const match = str(r.match);
  return {
    id,
    title: str(r.title) ?? 'Untitled',
    kind: kind && KINDS.has(kind) ? kind as DocumentSearchKind : 'page',
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

export function normalizeDocumentSearchPage(raw: unknown): DocumentSearchPage {
  const r = obj(raw);
  const f = obj(r.facets);
  const sort = str(r.sort);
  return {
    query: str(r.query) ?? '',
    sort: sort === 'updated' || sort === 'name' ? sort : 'relevance',
    total: num(r.total),
    libraryTotal: num(r.libraryTotal),
    items: arr(r.items).map(normalizeDocumentSearchItem).filter((i): i is DocumentSearchItem => i !== null),
    nextCursor: str(r.nextCursor),
    facets: {
      kinds: arr(f.kinds).map(obj).filter((k) => KINDS.has(String(k.kind))).map((k) => ({ kind: k.kind as DocumentSearchKind, count: num(k.count) })),
      owners: arr(f.owners).map(obj).filter((o) => str(o.id)).map((o) => ({ id: String(o.id), name: str(o.name) ?? String(o.id), count: num(o.count) })),
      folders: arr(f.folders).map(obj).filter((o) => str(o.id)).map((o) => ({ id: String(o.id), name: str(o.name) ?? '', parentFolderId: str(o.parentFolderId), count: num(o.count) })),
    },
  };
}

export interface DocumentSearchQuery {
  q: string;
  sort?: DocumentSearchSort;
  filters?: DocumentSearchFilters;
  limit?: number;
  cursor?: string | null;
  /** Skip the server's row cache — the document list just changed. */
  fresh?: boolean;
}

export function documentSearchUrl(apiBaseUrl: string, query: DocumentSearchQuery): string {
  const p = new URLSearchParams();
  if (query.q.trim()) p.set('q', query.q.trim());
  if (query.sort) p.set('sort', query.sort);
  const f = query.filters ?? {};
  if (f.kind?.length) p.set('kind', f.kind.join(','));
  if (f.owner?.length) p.set('owner', f.owner.join(','));
  if (f.folder) p.set('folder', f.folder);
  if (typeof f.since === 'number') p.set('since', String(f.since));
  if (query.limit) p.set('limit', String(query.limit));
  if (query.cursor) p.set('cursor', query.cursor);
  if (query.fresh) p.set('fresh', '1');
  const qs = p.toString();
  return `${apiBaseUrl}/api/document-search${qs ? `?${qs}` : ''}`;
}

/** `GET /api/document-search`. */
export async function fetchDocumentSearch(
  apiBaseUrl: string, idToken: string | null, query: DocumentSearchQuery, init?: { signal?: AbortSignal },
): Promise<DocumentSearchPage> {
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
