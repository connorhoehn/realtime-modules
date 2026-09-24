// realtime-modules/src/client/usePresentationRevisions.ts
//
// A presentation's revisions, a page at a time, shared by every view of the
// same deck (0.95.3, realtime-examples Loop 31 ppt — moved from the gateway
// frontend's `usePresentationDocument`).
//
// Source: platform-api `GET {apiBaseUrl}/api/documents/:id/revisions?limit=N
// [&before=vK]` (newest first, summaries; only the head carries its slide
// list; `total`, `nextCursor`) and `GET …/revisions/:rev` (one revision with
// its slide list). Both need a bearer. Since platform NFR #188 each revision
// is its own item, so a page is one Query.
//
// One cache per (api, document, signed-in person), held at module level: the
// editor, the document workbench and a run's deck card on the same deck read
// the head page ONCE between them, and "Older versions…" in one is read in all.
// A revision never changes, so nothing held goes stale except the head: a
// revision written while a view is open — a `/deck` run, a revise, another
// tab's save — arrives on the deck's channel as `revision-written` (NFR #15,
// via useDeckReviseStatus) and is PREPENDED with one `GET …/revisions/:rev`
// (not a page re-read). A gap (the frame names v9 while the head is v7)
// re-reads the head page instead.
//
// Hand-rolled views, not a component: the host renders with its own
// PresentationView/PresentationEditor and passes `olderCount`/`loadOlder` to
// their "Older versions (N)…" entry.

import { useCallback, useEffect, useState } from 'react';
import { useDeckReviseStatus } from './useDeckReviseStatus';
import type { PipelineRunTransport } from './pipelines/usePipelineRunStatus';

export interface PresentationSlideSummary {
  id: string;
  index: number;
  title: string;
  previewHandle?: string;
}

/** One revision, as the platform's revision routes shape it. */
export interface PresentationRevisionSummary {
  id: string;
  label: string;
  createdAt: string;
  createdBy: string;
  slideCount: number;
  contentType?: string;
  sizeBytes?: number;
  /** Whether the spec it was rendered from was kept (false: readable, not re-editable). */
  hasSpec?: boolean;
  sources?: Array<{ documentId: string; title: string; kind?: 'document' | 'transcript' }>;
  /** The run that wrote it, for a composer edit. */
  producedBy?: { pipelineId: string; runId: string; requestId: string };
  /** The deck's own title, sent only where it differs from the document's. */
  heading?: string;
  slides: PresentationSlideSummary[];
  /**
   * False for a revision a page named without its slide list (every one but
   * the head): `slides` is empty until it is focused. Absent means true.
   */
  slidesLoaded?: boolean;
}

/** Revisions per page. A deck keeps every revision (v40+ happens). */
export const PRESENTATION_REVISION_PAGE_SIZE = 10;

export type PresentationRevisionsStatus = 'loading' | 'ready' | 'empty' | 'error' | 'no-access';

export interface UsePresentationRevisionsOptions {
  /** platform-api origin, e.g. `http://localhost:13001`. */
  apiBaseUrl: string;
  documentId: string;
  /** Bearer. Null reads nothing. */
  idToken: string | null;
  /**
   * A revision the view must be able to show even when it is older than the
   * pages in hand (a `?revision=` link, a run card's revision, a pick from
   * the older list): read on its own, without marking the pages between as read.
   */
  focusRevisionId?: string | null;
  /** Default 10. Views sharing a cache should agree; the first view's size wins. */
  pageSize?: number;
  /** The deck channel's socket (see useDeckReviseStatus). Omit for the provider's; `null` turns the live prepend off. */
  transport?: PipelineRunTransport | null;
  /** For tests. Default `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface UsePresentationRevisionsResult {
  /** The deck document's title ('Presentation' until read). */
  title: string;
  /** Oldest first — only the pages (and focused revisions) read so far. */
  revisions: PresentationRevisionSummary[];
  /** Every revision the deck has, read or not. */
  total: number;
  /** Revisions older than the oldest paged one; `loadOlder` reads the next page. */
  olderCount: number;
  loadingOlder: boolean;
  loadOlder: () => void;
  /** `no-access`: 403/404 — the platform answers a deck you may not open like a missing one. */
  state: PresentationRevisionsStatus;
  error: string | null;
  /** Re-read the head page (keeps older pages: a revision never changes). */
  reload: () => void;
}

interface PageBody {
  title?: string;
  /** Absent from a replica that predates paging: then `revisions` is the whole list, oldest first. */
  total?: number;
  revisions?: Array<Omit<PresentationRevisionSummary, 'slides'> & { slides?: PresentationSlideSummary[] }>;
  nextCursor?: string | null;
}

interface Snapshot {
  hasData: boolean;
  title: string;
  total: number;
  revisions: PresentationRevisionSummary[];
  /** Ids the list pages named, newest back to the oldest read: what `before=` continues from. */
  paged: string[];
  loading: boolean;
  loadingOlder: boolean;
  noAccess: boolean;
  error: string | null;
}

interface Entry {
  snap: Snapshot;
  listeners: Set<() => void>;
  head?: Promise<void>;
  older?: Promise<void>;
  one: Map<string, Promise<void>>;
  refs: number;
}

const EMPTY: Snapshot = { hasData: false, title: 'Presentation', total: 0, revisions: [], paged: [], loading: false, loadingOlder: false, noAccess: false, error: null };
const entries = new Map<string, Entry>();
/** Unshown decks kept (their pages survive navigating away and back). */
const KEEP_UNSHOWN = 8;

/** Whose token this is, so a second person on the same tab never reads the first one's list. */
function tokenSubject(idToken: string | null): string {
  try {
    const payload = idToken?.split('.')[1];
    if (!payload) return '';
    const sub = (JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown }).sub;
    return typeof sub === 'string' ? sub : '';
  } catch {
    return '';
  }
}

const versionOf = (id: string): number => Number(/^v(\d+)$/.exec(id)?.[1] ?? NaN);

function viewOf(revision: NonNullable<PageBody['revisions']>[number]): PresentationRevisionSummary {
  return { ...revision, slides: revision.slides ?? [], slidesLoaded: Array.isArray(revision.slides) };
}

/** Oldest first, one entry per id; a copy with its slides wins over one without. */
export function mergePresentationRevisions(...lists: PresentationRevisionSummary[][]): PresentationRevisionSummary[] {
  const byId = new Map<string, PresentationRevisionSummary>();
  for (const list of lists) {
    for (const revision of list) {
      const held = byId.get(revision.id);
      byId.set(revision.id, held && held.slidesLoaded !== false && revision.slidesLoaded === false ? held : revision);
    }
  }
  return [...byId.values()].sort((a, b) => {
    const na = versionOf(a.id);
    const nb = versionOf(b.id);
    return Number.isNaN(na) || Number.isNaN(nb) ? a.createdAt.localeCompare(b.createdAt) : na - nb;
  });
}

function update(entry: Entry, patch: (snap: Snapshot) => Snapshot): void {
  entry.snap = patch(entry.snap);
  for (const listener of entry.listeners) listener();
}

interface Ctx { base: string; idToken: string; pageSize: number; fetchImpl: typeof fetch }

function readHead(entry: Entry, ctx: Ctx): Promise<void> {
  entry.head ??= (async () => {
    await null; // settle after `entry.head` is set, even on a synchronous throw
    update(entry, (s) => ({ ...s, loading: true }));
    try {
      const res = await ctx.fetchImpl(`${ctx.base}?limit=${ctx.pageSize}`, { headers: { authorization: `Bearer ${ctx.idToken}` } });
      if (res.status === 403 || res.status === 404) {
        update(entry, (s) => ({ ...EMPTY, noAccess: true, loadingOlder: s.loadingOlder }));
        return;
      }
      if (!res.ok) throw new Error(`The presentation could not be read (the server answered ${res.status}).`);
      const body = await res.json() as PageBody;
      const pagedAnswer = typeof body.total === 'number';
      const page = (pagedAnswer ? [...(body.revisions ?? [])].reverse() : body.revisions ?? []).map(viewOf);
      update(entry, (s) => ({
        ...s,
        hasData: true,
        title: body.title ?? s.title,
        total: pagedAnswer ? body.total! : page.length,
        revisions: mergePresentationRevisions(s.revisions, page),
        paged: [...new Set([...s.paged, ...page.map((revision) => revision.id)])],
        noAccess: false,
        error: null,
        loading: false,
      }));
    } catch (err) {
      update(entry, (s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : 'The presentation could not be read' }));
    } finally {
      entry.head = undefined;
    }
  })();
  return entry.head;
}

function olderCursor(snap: Snapshot): string | null {
  const paged = snap.revisions.filter((revision) => snap.paged.includes(revision.id));
  return snap.total - paged.length > 0 ? paged[0]?.id ?? null : null;
}

function readOlder(entry: Entry, ctx: Ctx): void {
  const cursor = olderCursor(entry.snap);
  if (!cursor || entry.older) return;
  entry.older = (async () => {
    await null;
    update(entry, (s) => ({ ...s, loadingOlder: true }));
    try {
      const res = await ctx.fetchImpl(`${ctx.base}?limit=${ctx.pageSize}&before=${encodeURIComponent(cursor)}`, { headers: { authorization: `Bearer ${ctx.idToken}` } });
      if (!res.ok) throw new Error(`Older revisions could not be read (the server answered ${res.status}).`);
      const body = await res.json() as PageBody;
      const page = [...(body.revisions ?? [])].reverse().map(viewOf);
      update(entry, (s) => ({
        ...s,
        revisions: mergePresentationRevisions(s.revisions, page),
        paged: [...new Set([...s.paged, ...page.map((revision) => revision.id)])],
      }));
    } catch (err) {
      update(entry, (s) => ({ ...s, error: err instanceof Error ? err.message : 'Older revisions could not be read' }));
    } finally {
      entry.older = undefined;
      update(entry, (s) => ({ ...s, loadingOlder: false }));
    }
  })();
}

/**
 * One revision with its slide list. `asHead`: it was just written — when it is
 * the next version after the paged head it joins the pages (and `total`);
 * otherwise (a gap, an unversioned id) the head page is re-read.
 */
function readOne(entry: Entry, ctx: Ctx, revisionId: string, asHead: boolean): Promise<void> {
  const held = entry.one.get(revisionId);
  if (held) return held;
  const run = (async () => {
    await null;
    try {
      const res = await ctx.fetchImpl(`${ctx.base}/${encodeURIComponent(revisionId)}`, { headers: { authorization: `Bearer ${ctx.idToken}` } });
      if (!res.ok) { if (asHead) await readHead(entry, ctx); return; }
      const body = await res.json() as { revision?: NonNullable<PageBody['revisions']>[number] };
      if (!body.revision) return;
      const one = viewOf(body.revision);
      if (!asHead) {
        update(entry, (s) => ({ ...s, revisions: mergePresentationRevisions(s.revisions, [one]) }));
        return;
      }
      const s = entry.snap;
      const headVersion = Math.max(0, ...s.paged.map(versionOf).filter((n) => !Number.isNaN(n)));
      if (s.paged.includes(one.id)) {
        update(entry, (cur) => ({ ...cur, revisions: mergePresentationRevisions(cur.revisions, [one]) }));
      } else if (versionOf(one.id) === headVersion + 1) {
        update(entry, (cur) => ({
          ...cur,
          total: Math.max(cur.total + 1, versionOf(one.id)),
          revisions: mergePresentationRevisions(cur.revisions, [one]),
          paged: [...cur.paged, one.id],
        }));
      } else {
        update(entry, (cur) => ({ ...cur, revisions: mergePresentationRevisions(cur.revisions, [one]) }));
        await readHead(entry, ctx);
      }
    } catch {
      // An unreadable revision stays as the pages listed it.
    } finally {
      entry.one.delete(revisionId);
    }
  })();
  entry.one.set(revisionId, run);
  return run;
}

function acquire(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { snap: EMPTY, listeners: new Set(), one: new Map(), refs: 0 };
    entries.set(key, entry);
  }
  // Most recently used last.
  entries.delete(key);
  entries.set(key, entry);
  return entry;
}

function evictUnshown(): void {
  let unshown = [...entries.values()].filter((entry) => entry.refs <= 0).length;
  for (const [key, entry] of entries) {
    if (unshown <= KEEP_UNSHOWN) return;
    if (entry.refs > 0 || entry.head || entry.older) continue;
    entries.delete(key);
    unshown -= 1;
  }
}

/** Drops every held list (sign-out, tests). */
export function releasePresentationRevisions(): void {
  entries.clear();
}

export function usePresentationRevisions(opts: UsePresentationRevisionsOptions): UsePresentationRevisionsResult {
  const { apiBaseUrl, documentId, idToken, focusRevisionId, transport } = opts;
  const pageSize = opts.pageSize ?? PRESENTATION_REVISION_PAGE_SIZE;
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const base = `${apiBaseUrl}/api/documents/${encodeURIComponent(documentId)}/revisions`;
  const key = idToken && documentId ? `${base}\u0000${tokenSubject(idToken)}` : '';
  const [snap, setSnap] = useState<Snapshot>(() => (key ? entries.get(key)?.snap ?? EMPTY : EMPTY));
  const ctxRef = { base, idToken: idToken ?? '', pageSize, fetchImpl };

  useEffect(() => {
    if (!key) { setSnap(EMPTY); return undefined; }
    const entry = acquire(key);
    entry.refs += 1;
    const listener = () => setSnap(entry.snap);
    entry.listeners.add(listener);
    setSnap(entry.snap);
    // A deck another view already read costs nothing; a first view reads the head.
    if (!entry.snap.hasData && !entry.snap.noAccess) void readHead(entry, ctxRef);
    return () => {
      entry.listeners.delete(listener);
      entry.refs -= 1;
      evictUnshown();
    };
    // The context is rebuilt each render; the key is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const reload = useCallback(() => {
    const entry = key ? entries.get(key) : undefined;
    if (entry) void readHead(entry, ctxRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loadOlder = useCallback(() => {
    const entry = key ? entries.get(key) : undefined;
    if (entry) readOlder(entry, ctxRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // The focused revision: its summary and slide list, when the pages lack them.
  const focus = focusRevisionId ? snap.revisions.find((revision) => revision.id === focusRevisionId) : undefined;
  const needsFocus = !!focusRevisionId && snap.hasData && (!focus || focus.slidesLoaded === false);
  useEffect(() => {
    const entry = key ? entries.get(key) : undefined;
    if (!needsFocus || !entry || !focusRevisionId) return;
    void readOne(entry, ctxRef, focusRevisionId, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, focusRevisionId, needsFocus]);

  // NFR #15: a revision written while the view is open — prepended, one GET.
  const { lastWritten } = useDeckReviseStatus(documentId, transport === undefined ? {} : { transport });
  const writtenId = lastWritten?.revisionId;
  useEffect(() => {
    const entry = key ? entries.get(key) : undefined;
    if (!writtenId || !entry || !entry.snap.hasData) return;
    const held = entry.snap.revisions.find((revision) => revision.id === writtenId);
    if (held && entry.snap.paged.includes(writtenId)) return;
    void readOne(entry, ctxRef, writtenId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, writtenId, lastWritten?.receivedAt]);

  const paged = snap.revisions.filter((revision) => snap.paged.includes(revision.id));
  const olderCount = snap.hasData ? Math.max(0, snap.total - paged.length) : 0;
  return {
    title: snap.title,
    revisions: snap.revisions,
    total: snap.total,
    olderCount,
    loadingOlder: snap.loadingOlder,
    loadOlder,
    state: !snap.hasData && snap.noAccess ? 'no-access'
      : !snap.hasData && snap.error ? 'error'
        : !snap.hasData ? 'loading'
          : snap.revisions.length === 0 ? 'empty' : 'ready',
    error: snap.error,
    reload,
  };
}
