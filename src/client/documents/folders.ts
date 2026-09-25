// realtime-modules/src/client/documents/folders.ts
//
// useDocumentFolders() — the Documents explorer's folders: the tree, per-folder
// counts, every document's folder, and the mutations, live over the gateway's
// `document-folders` service (realtime-examples, documents-folders R1).
//
// ## Where the truth is
//
// The gateway keeps folder records and each document's placement in the
// document metadata store. `subscribe` answers with the whole picture for THIS
// viewer (only documents they may read; folders they can see through one of
// those documents or because they made it) and joins the org hub channel
// `doc-folders:<orgId>`. Every change anyone makes, on any gateway replica, is
// signalled there as a `document-folders:event` — ids and versions only
// (`folderUpserted {folderId, version}`, `folderDeleted {folderId}`,
// `documentsMoved {documentIds, versions}`), never a folder name, because every
// org member hears it. This hook answers a signal about something newer than it
// holds by re-reading just those ids (`read {folderIds, documentIds}`); the
// gateway answers per viewer (`document-folders:read`: the folders this viewer
// may see, with names; the named ones it may not, as bare `hiddenFolderIds`;
// the placements of the named documents it can read). Signals arriving
// together are coalesced into one read. There is no polling. A reconnect (new
// session epoch) re-subscribes and replaces the picture, which heals anything
// missed while offline.
//
// ## Counts
//
// The server derives `count` (the folder and everything under it) and
// `directCount` from the store. Between lists the same numbers are re-derived
// here from the placements, which the events keep current — so a move made in
// another tab moves the numbers too. Only documents this viewer could already
// see are counted: an event about a document it was never shown is ignored.
//
// ## Writes
//
// Every mutation carries a fresh `requestId` (the server answers a retry of it
// from the first outcome) and, for moves, the placement `version` this client
// saw — a move of something someone else just moved is refused as a
// `conflict` carrying the current placement, and this hook shows that instead
// of the optimistic guess. Moves are optimistic; everything else waits for the
// answer.
//
// ## Trash
//
// Trash is soft: `trashDocuments(ids)` sets `trashedAt`/`trashedBy` on each
// placement and `restoreDocuments(ids)` clears them; folder and position are
// never touched, so a restore puts the document back where it was. Trashed
// documents stay in `placements` (and in `trashed`, newest first) but are
// counted nowhere — not in folder counts, the tree, `unfiled` or `totalCount`.
// Both are optimistic like moves and roll back on refusal.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PipelineRunTransport } from '../pipelines/usePipelineRunStatus';
import { useResolvedTransport } from './transport';

export interface DocumentFolder {
  id: string;
  name: string;
  parentFolderId: string | null;
  position: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Visible documents in this folder and every folder under it. */
  count: number;
  /** Visible documents directly in this folder. */
  directCount: number;
}

export interface DocumentFolderNode extends DocumentFolder {
  depth: number;
  children: DocumentFolderNode[];
  /** Ids of the visible documents directly in this folder, by position. */
  documentIds: string[];
}

export interface DocumentFolderPlacement {
  documentId: string;
  /** null = Unfiled. */
  folderId: string | null;
  position: number;
  version: number;
  /** ISO time it was put in the trash; absent when it is not trashed. */
  trashedAt?: string;
  /** Who trashed it. */
  trashedBy?: string;
  /** True while an optimistic move waits for the server. */
  pending?: boolean;
}

export interface DocumentFolderTrashedItem {
  documentId: string;
  trashedAt: string;
  trashedBy?: string;
  /** The folder it will be restored into (null = Unfiled, or its folder is gone). */
  folderId: string | null;
}

export interface DocumentFolderMove {
  documentId: string;
  folderId: string | null;
  position?: number;
}

export interface DocumentFolderResult {
  ok: boolean;
  requestId: string;
  code?: 'conflict' | 'forbidden' | 'not_found' | 'not_empty' | 'invalid' | 'unauthenticated' | 'unavailable' | 'internal' | 'timeout' | 'disconnected' | string;
  message?: string;
  folder?: Omit<DocumentFolder, 'count' | 'directCount'>;
  folderId?: string;
  placements?: DocumentFolderPlacement[];
  results?: Array<{ documentId: string; ok: boolean; code?: string; message?: string; placement?: DocumentFolderPlacement; current?: DocumentFolderPlacement }>;
  replay?: boolean;
}

export interface UseDocumentFoldersOptions {
  /** A host-owned socket. Omit to use the nearest GatewaySocketProvider; `null` disables. */
  transport?: PipelineRunTransport | null;
  /** The host socket's session epoch, for a host-owned transport. */
  sessionEpoch?: number;
  /** `false` mounts nothing. Default true. */
  enabled?: boolean;
  /** The viewer's user id — folders they created stay visible while empty. */
  currentUserId?: string | null;
  /** How long a mutation waits for its answer. Default 10 s. */
  timeoutMs?: number;
}

export interface UseDocumentFoldersResult {
  /** Visible folders, flat, with live counts. */
  folders: DocumentFolder[];
  /** The same folders as a tree (roots first, siblings by position). */
  tree: DocumentFolderNode[];
  /** Every visible document's placement, by document id. */
  placements: Record<string, DocumentFolderPlacement>;
  /** The folder a document is in; null for Unfiled or unknown. */
  folderOf: (documentId: string) => string | null;
  /** The folder and its ancestors, root first — for breadcrumbs. */
  pathOf: (folderId: string | null | undefined) => DocumentFolder[];
  /** Visible documents in no folder, by position. */
  unfiled: string[];
  unfiledCount: number;
  /** Visible documents in total, trashed ones excluded. */
  totalCount: number;
  /** Visible trashed documents, newest first. */
  trashed: DocumentFolderTrashedItem[];
  isTrashed: (documentId: string) => boolean;
  /** True until the first list for this session arrives. */
  loading: boolean;
  /** The last failed mutation or read, until the next success. */
  error?: DocumentFolderResult;
  createFolder: (input: { name: string; parentFolderId?: string | null; position?: number }) => Promise<DocumentFolderResult>;
  renameFolder: (folderId: string, name: string) => Promise<DocumentFolderResult>;
  moveFolder: (folderId: string, parentFolderId: string | null, position?: number) => Promise<DocumentFolderResult>;
  /** Only an empty folder can be deleted (`not_empty` otherwise). */
  deleteFolder: (folderId: string) => Promise<DocumentFolderResult>;
  moveDocuments: (moves: DocumentFolderMove[]) => Promise<DocumentFolderResult>;
  moveDocument: (documentId: string, folderId: string | null, position?: number) => Promise<DocumentFolderResult>;
  /** Soft delete (≤100): the documents leave every count and list but keep their folder and position. */
  trashDocuments: (documentIds: string[]) => Promise<DocumentFolderResult>;
  /** Take documents out of the trash, back where they were. */
  restoreDocuments: (documentIds: string[]) => Promise<DocumentFolderResult>;
  /** Re-read the whole picture (a fresh `list`). */
  refresh: () => void;
}

const SERVICE = 'document-folders';

/** A position strictly between two neighbours (either may be missing), for drag-reorder. */
export function positionBetween(before?: number | null, after?: number | null): number {
  const b = typeof before === 'number' && Number.isFinite(before) ? before : undefined;
  const a = typeof after === 'number' && Number.isFinite(after) ? after : undefined;
  if (b === undefined && a === undefined) return 1;
  if (b === undefined) return (a as number) - 1;
  if (a === undefined) return b + 1;
  return (b + a) / 2;
}

function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `rq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type DocumentFolderRecord = Omit<DocumentFolder, 'count' | 'directCount'> & { listed?: boolean };
type FolderRecord = DocumentFolderRecord;

/** The hook's raw picture: folder records + placements, before derivation. */
export interface DocumentFoldersState {
  folders: Record<string, FolderRecord>;
  placements: Record<string, DocumentFolderPlacement>;
}
type State = DocumentFoldersState;

/** A placement off the wire, keeping only known fields (trash state included). */
function toPlacement(p: DocumentFolderPlacement): DocumentFolderPlacement {
  return {
    documentId: p.documentId, folderId: p.folderId ?? null, position: p.position, version: p.version,
    ...(typeof p.trashedAt === 'string' ? { trashedAt: p.trashedAt } : {}),
    ...(typeof p.trashedAt === 'string' && typeof p.trashedBy === 'string' ? { trashedBy: p.trashedBy } : {}),
  };
}

/** Folder + ancestors, cycle-safe. */
function ancestry(folders: Record<string, FolderRecord>, folderId: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = folderId ?? null;
  while (cur && folders[cur] && !seen.has(cur)) { seen.add(cur); out.push(cur); cur = folders[cur].parentFolderId; }
  return out;
}

/** Pure derivation of the visible tree and counts — exported for tests and non-React callers. */
export function deriveDocumentFolders(state: State, currentUserId?: string | null) {
  const count: Record<string, number> = {};
  const direct: Record<string, number> = {};
  const docsIn: Record<string, DocumentFolderPlacement[]> = {};
  const unfiled: DocumentFolderPlacement[] = [];
  const trashed: DocumentFolderTrashedItem[] = [];
  for (const p of Object.values(state.placements)) {
    const fid = p.folderId && state.folders[p.folderId] ? p.folderId : null;
    if (p.trashedAt) { trashed.push({ documentId: p.documentId, trashedAt: p.trashedAt, ...(p.trashedBy ? { trashedBy: p.trashedBy } : {}), folderId: fid }); continue; }
    if (!fid) { unfiled.push(p); continue; }
    direct[fid] = (direct[fid] ?? 0) + 1;
    (docsIn[fid] ??= []).push(p);
    for (const id of ancestry(state.folders, fid)) count[id] = (count[id] ?? 0) + 1;
  }
  const visible = new Set<string>();
  for (const f of Object.values(state.folders)) {
    if (f.listed || (count[f.id] ?? 0) > 0 || (currentUserId && f.createdBy === currentUserId)) {
      for (const id of ancestry(state.folders, f.id)) visible.add(id);
    }
  }
  const bySort = (a: { position: number; name?: string; documentId?: string }, b: { position: number; name?: string; documentId?: string }) =>
    a.position - b.position || String(a.name ?? a.documentId).localeCompare(String(b.name ?? b.documentId));
  const folders: DocumentFolder[] = [...visible].map((id) => {
    const { listed: _listed, ...f } = state.folders[id];
    return { ...f, count: count[id] ?? 0, directCount: direct[id] ?? 0 };
  }).sort(bySort);
  const nodes: Record<string, DocumentFolderNode> = {};
  for (const f of folders) nodes[f.id] = { ...f, depth: 0, children: [], documentIds: (docsIn[f.id] ?? []).sort(bySort).map((p) => p.documentId) };
  const tree: DocumentFolderNode[] = [];
  for (const f of folders) {
    const parent = f.parentFolderId ? nodes[f.parentFolderId] : undefined;
    if (parent) parent.children.push(nodes[f.id]); else tree.push(nodes[f.id]);
  }
  const setDepth = (list: DocumentFolderNode[], depth: number) => { for (const n of list) { n.depth = depth; setDepth(n.children, depth + 1); } };
  setDepth(tree, 0);
  trashed.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt) || a.documentId.localeCompare(b.documentId));
  return { folders, tree, unfiled: unfiled.sort(bySort).map((p) => p.documentId), trashed, totalCount: Object.keys(state.placements).length - trashed.length };
}

export function useDocumentFolders(options: UseDocumentFoldersOptions = {}): UseDocumentFoldersResult {
  const { transport, sessionEpoch, enabled = true, currentUserId, timeoutMs = 10_000 } = options;
  const { send, onMessage, epoch } = useResolvedTransport(transport, sessionEpoch);
  const active = enabled && !!send && !!onMessage;

  const [state, setState] = useState<State>({ folders: {}, placements: {} });
  const [loading, setLoading] = useState(active);
  const [error, setError] = useState<DocumentFolderResult | undefined>(undefined);
  const pending = useRef(new Map<string, { resolve: (r: DocumentFolderResult) => void; timer: ReturnType<typeof setTimeout>; onSettle?: (r: DocumentFolderResult) => void }>());
  const stateRef = useRef(state);
  stateRef.current = state;
  const sendRef = useRef(send);
  sendRef.current = send;

  // Signals waiting to be re-read, coalesced into one `read` per tick.
  const rereadRef = useRef<{ folderIds: Set<string>; documentIds: Set<string>; timer: ReturnType<typeof setTimeout> | null }>({ folderIds: new Set(), documentIds: new Set(), timer: null });
  const flushReread = useCallback(() => {
    const q = rereadRef.current;
    q.timer = null;
    const folderIds = [...q.folderIds];
    const documentIds = [...q.documentIds];
    q.folderIds.clear();
    q.documentIds.clear();
    if (!folderIds.length && !documentIds.length) return;
    try { sendRef.current?.({ service: SERVICE, action: 'read', requestId: newRequestId(), folderIds, documentIds }); } catch { /* socket gone; the next subscribe heals */ }
  }, []);
  useEffect(() => () => { const q = rereadRef.current; if (q.timer) clearTimeout(q.timer); q.timer = null; }, []);

  // Inbound frames: the list, mutation answers, hub events, and the CRDT
  // service's own create/delete broadcasts (a new document starts Unfiled).
  useEffect(() => {
    if (!active || !onMessage) return undefined;
    return onMessage((raw) => {
      const frame = raw as Record<string, any> | null;
      if (!frame || typeof frame !== 'object') return;
      if (frame.type === 'document-folders:list') {
        const folders: Record<string, FolderRecord> = {};
        for (const f of (frame.folders ?? []) as DocumentFolder[]) {
          const { count: _c, directCount: _d, ...rec } = f;
          folders[f.id] = { ...rec, listed: true };
        }
        const placements: Record<string, DocumentFolderPlacement> = {};
        for (const p of (frame.documents ?? []) as DocumentFolderPlacement[]) if (p?.documentId) placements[p.documentId] = toPlacement(p);
        setState({ folders, placements });
        setLoading(false);
        return;
      }
      if (frame.type === 'document-folders:result') {
        const entry = typeof frame.requestId === 'string' ? pending.current.get(frame.requestId) : undefined;
        if (frame.action === 'list' || frame.action === 'subscribe') { if (!frame.ok) { setError(frame as DocumentFolderResult); setLoading(false); } }
        if (!entry) return;
        pending.current.delete(frame.requestId);
        clearTimeout(entry.timer);
        const result = frame as DocumentFolderResult;
        entry.onSettle?.(result);
        setError(result.ok ? undefined : result);
        entry.resolve(result);
        return;
      }
      if (frame.type === 'document-folders:event') {
        const ask = documentFolderSignalReads(stateRef.current, frame);
        if (ask) {
          for (const id of ask.folderIds) rereadRef.current.folderIds.add(id);
          for (const id of ask.documentIds) rereadRef.current.documentIds.add(id);
          if (!rereadRef.current.timer) rereadRef.current.timer = setTimeout(flushReread, 0);
          return;
        }
        setState((prev) => mergeEvent(prev, frame));
        return;
      }
      if (frame.type === 'document-folders:read') {
        setState((prev) => mergeDocumentFolderRead(prev, frame));
        return;
      }
      if (frame.type === 'crdt' && frame.action === 'documentCreated' && frame.document?.id) {
        const id = String(frame.document.id);
        setState((prev) => (prev.placements[id] ? prev : { ...prev, placements: { ...prev.placements, [id]: { documentId: id, folderId: null, position: 0, version: 0 } } }));
        return;
      }
      if (frame.type === 'crdt' && frame.action === 'documentDeleted' && frame.documentId) {
        const id = String(frame.documentId);
        setState((prev) => {
          if (!prev.placements[id]) return prev;
          const { [id]: _gone, ...rest } = prev.placements;
          return { ...prev, placements: rest };
        });
      }
    });
  }, [active, onMessage, flushReread]);

  // Subscribe once per session (a reconnect is a new epoch → a fresh picture).
  //
  // Epoch 0 means the socket has no session yet: a frame sent now is dropped
  // on the floor (the socket's send is a silent no-op until it is open), and
  // nothing would ever send it again — the explorer sat on "Loading folders…"
  // on every page load that mounted this before the socket opened. Wait for
  // the first session instead; its epoch bump runs this again. An unknown
  // epoch (undefined) keeps the old subscribe-now behaviour.
  useEffect(() => {
    if (!active || !send) return undefined;
    setLoading(true);
    if (epoch === 0) return undefined;
    send({ service: SERVICE, action: 'subscribe', requestId: newRequestId() });
    return () => { try { send({ service: SERVICE, action: 'unsubscribe' }); } catch { /* socket already gone */ } };
  }, [active, send, epoch]);

  // Unanswered requests fail rather than hang when the hook unmounts.
  useEffect(() => () => {
    for (const [requestId, entry] of pending.current) { clearTimeout(entry.timer); entry.resolve({ ok: false, requestId, code: 'disconnected', message: 'Folders view closed' }); }
    pending.current.clear();
  }, []);

  const request = useCallback((action: string, body: Record<string, unknown>, onSettle?: (r: DocumentFolderResult) => void): Promise<DocumentFolderResult> => {
    const requestId = newRequestId();
    const s = sendRef.current;
    if (!active || !s) {
      const r: DocumentFolderResult = { ok: false, requestId, code: 'disconnected', message: 'Not connected' };
      onSettle?.(r);
      return Promise.resolve(r);
    }
    return new Promise<DocumentFolderResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.current.delete(requestId);
        const r: DocumentFolderResult = { ok: false, requestId, code: 'timeout', message: 'No answer from the gateway' };
        onSettle?.(r);
        setError(r);
        resolve(r);
      }, timeoutMs);
      pending.current.set(requestId, { resolve, timer, onSettle });
      s({ service: SERVICE, action, requestId, ...body });
    });
  }, [active, timeoutMs]);

  const expectedVersionOf = (folderId: string) => stateRef.current.folders[folderId]?.version ?? 1;

  const upsertFromResult = useCallback((r: DocumentFolderResult) => {
    if (r.ok && r.folder) setState((prev) => mergeEvent(prev, { kind: 'folderUpserted', folder: r.folder }));
    if (r.ok && r.folderId && !r.folder) setState((prev) => mergeEvent(prev, { kind: 'folderDeleted', folderId: r.folderId }));
  }, []);

  const createFolder = useCallback((input: { name: string; parentFolderId?: string | null; position?: number }) =>
    request('createFolder', { name: input.name, parentFolderId: input.parentFolderId ?? null, ...(input.position !== undefined ? { position: input.position } : {}) }, upsertFromResult), [request, upsertFromResult]);
  const renameFolder = useCallback((folderId: string, name: string) =>
    request('renameFolder', { folderId, name, expectedVersion: expectedVersionOf(folderId) }, upsertFromResult), [request, upsertFromResult]);
  const moveFolder = useCallback((folderId: string, parentFolderId: string | null, position?: number) =>
    request('moveFolder', { folderId, parentFolderId, expectedVersion: expectedVersionOf(folderId), ...(position !== undefined ? { position } : {}) }, upsertFromResult), [request, upsertFromResult]);
  const deleteFolder = useCallback((folderId: string) =>
    request('deleteFolder', { folderId, expectedVersion: expectedVersionOf(folderId) }, upsertFromResult), [request, upsertFromResult]);

  const moveDocuments = useCallback((moves: DocumentFolderMove[]) => {
    const before: Record<string, DocumentFolderPlacement | undefined> = {};
    const wire = moves.map((m) => {
      const cur = stateRef.current.placements[m.documentId];
      before[m.documentId] = cur;
      return { documentId: m.documentId, folderId: m.folderId, expectedVersion: cur?.version ?? 0, ...(m.position !== undefined ? { position: m.position } : {}) };
    });
    // Optimistic: the rows move under the pointer, marked pending.
    setState((prev) => {
      const placements = { ...prev.placements };
      for (const m of moves) {
        const cur = placements[m.documentId];
        placements[m.documentId] = { documentId: m.documentId, folderId: m.folderId, position: m.position ?? cur?.position ?? 0, version: cur?.version ?? 0, pending: true };
      }
      return { ...prev, placements };
    });
    return request('moveDocuments', { moves: wire }, (r) => {
      setState((prev) => {
        const placements = { ...prev.placements };
        const byDoc = new Map((r.results ?? []).map((x) => [x.documentId, x]));
        for (const m of moves) {
          const res = byDoc.get(m.documentId);
          const settled = res?.ok ? res.placement : res?.current ?? before[m.documentId];
          const now = placements[m.documentId];
          // An event may already have landed something newer.
          if (now && !now.pending && settled && now.version > settled.version) continue;
          if (settled) placements[m.documentId] = toPlacement({ ...settled, documentId: m.documentId });
          else delete placements[m.documentId];
        }
        return { ...prev, placements };
      });
    });
  }, [request]);

  const moveDocument = useCallback((documentId: string, folderId: string | null, position?: number) =>
    moveDocuments([{ documentId, folderId, ...(position !== undefined ? { position } : {}) }]), [moveDocuments]);

  const setTrash = useCallback((documentIds: string[], trashed: boolean) => {
    const ids = [...new Set(documentIds.filter((id) => typeof id === 'string' && id))];
    const before: Record<string, DocumentFolderPlacement | undefined> = {};
    for (const id of ids) before[id] = stateRef.current.placements[id];
    const at = new Date().toISOString();
    // Optimistic: the rows leave (or come back) at once, marked pending.
    setState((prev) => {
      const placements = { ...prev.placements };
      for (const id of ids) {
        const cur = placements[id] ?? { documentId: id, folderId: null, position: 0, version: 0 };
        const { trashedAt: _a, trashedBy: _b, ...rest } = cur;
        placements[id] = trashed
          ? { ...rest, trashedAt: cur.trashedAt ?? at, ...(cur.trashedBy ? { trashedBy: cur.trashedBy } : currentUserId ? { trashedBy: currentUserId } : {}), pending: true }
          : { ...rest, pending: true };
      }
      return { ...prev, placements };
    });
    return request(trashed ? 'trashDocuments' : 'restoreDocuments', { documentIds: ids }, (r) => {
      setState((prev) => {
        const placements = { ...prev.placements };
        const byDoc = new Map((r.results ?? []).map((x) => [x.documentId, x]));
        for (const id of ids) {
          const res = byDoc.get(id);
          const settled = res?.ok ? res.placement : before[id];
          const now = placements[id];
          // An event may already have landed something newer.
          if (now && !now.pending && settled && now.version > settled.version) continue;
          if (settled) placements[id] = toPlacement({ ...settled, documentId: id });
          else delete placements[id];
        }
        return { ...prev, placements };
      });
    });
  }, [request, currentUserId]);
  const trashDocuments = useCallback((documentIds: string[]) => setTrash(documentIds, true), [setTrash]);
  const restoreDocuments = useCallback((documentIds: string[]) => setTrash(documentIds, false), [setTrash]);
  const isTrashed = useCallback((documentId: string) => !!state.placements[documentId]?.trashedAt, [state.placements]);

  const refresh = useCallback(() => {
    if (active && sendRef.current) sendRef.current({ service: SERVICE, action: 'list', requestId: newRequestId() });
  }, [active]);

  const derived = useMemo(() => deriveDocumentFolders(state, currentUserId), [state, currentUserId]);
  const folderOf = useCallback((documentId: string) => {
    const fid = state.placements[documentId]?.folderId ?? null;
    return fid && state.folders[fid] ? fid : null;
  }, [state]);
  const byId = useMemo(() => new Map(derived.folders.map((f) => [f.id, f])), [derived.folders]);
  const pathOf = useCallback((folderId: string | null | undefined) =>
    ancestry(state.folders, folderId).reverse().map((id) => byId.get(id)).filter((f): f is DocumentFolder => !!f), [state.folders, byId]);

  return {
    folders: derived.folders,
    tree: derived.tree,
    placements: state.placements,
    folderOf,
    pathOf,
    unfiled: derived.unfiled,
    unfiledCount: derived.unfiled.length,
    totalCount: derived.totalCount,
    trashed: derived.trashed,
    isTrashed,
    loading: active ? loading : false,
    error,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
    moveDocuments,
    moveDocument,
    trashDocuments,
    restoreDocuments,
    refresh,
  };
}

/**
 * What an id-only hub signal needs re-read, or null when the signal is merged
 * directly (a delete, a legacy full event) or names nothing newer than this
 * picture holds. The folder ids include the local parent chain, so a folder
 * this viewer no longer has a reason to see comes back as hidden. Exported for
 * tests.
 */
export function documentFolderSignalReads(prev: State, event: Record<string, any>): { folderIds: string[]; documentIds: string[] } | null {
  const folderIds = new Set<string>();
  const documentIds = new Set<string>();
  if (event.kind === 'folderUpserted' && !event.folder && typeof event.folderId === 'string') {
    const cur = prev.folders[event.folderId];
    if (cur && typeof event.version === 'number' && cur.version >= event.version) return { folderIds: [], documentIds: [] };
    folderIds.add(event.folderId);
    for (const id of ancestry(prev.folders, cur?.parentFolderId)) folderIds.add(id);
  } else if (event.kind === 'documentsMoved' && !Array.isArray(event.moves) && Array.isArray(event.documentIds)) {
    const versions: unknown[] = Array.isArray(event.versions) ? event.versions : [];
    (event.documentIds as unknown[]).forEach((raw, i) => {
      if (typeof raw !== 'string') return;
      const cur = prev.placements[raw];
      const v = versions[i];
      if (cur && !cur.pending && typeof v === 'number' && cur.version >= v) return;
      documentIds.add(raw);
      // Where it was: that folder may now be empty for this viewer.
      for (const id of ancestry(prev.folders, cur?.folderId)) folderIds.add(id);
    });
  } else {
    return null;
  }
  return { folderIds: [...folderIds], documentIds: [...documentIds] };
}

/**
 * Merge a `document-folders:read` answer: visible folders replace what is held
 * (and are shown), hidden ones leave with everything under them, and the named
 * documents' placements update unless something newer is already held.
 * Exported for tests.
 */
export function mergeDocumentFolderRead(prev: State, frame: Record<string, any>): State {
  let folders: Record<string, FolderRecord> | null = null;
  const hidden = Array.isArray(frame.hiddenFolderIds) ? (frame.hiddenFolderIds as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (hidden.length) {
    const gone = new Set(hidden);
    const all = Object.values(prev.folders);
    // A hidden folder hides its subtree (a visible folder's ancestors are always visible).
    for (let grew = true; grew;) {
      grew = false;
      for (const f of all) if (!gone.has(f.id) && f.parentFolderId && gone.has(f.parentFolderId)) { gone.add(f.id); grew = true; }
    }
    for (const id of gone) {
      if (!prev.folders[id]) continue;
      folders ??= { ...prev.folders };
      delete folders[id];
    }
  }
  for (const f of (Array.isArray(frame.folders) ? frame.folders : []) as DocumentFolder[]) {
    if (!f?.id) continue;
    const cur = (folders ?? prev.folders)[f.id];
    if (cur && cur.version > f.version) continue;
    const { count: _c, directCount: _d, ...rec } = f;
    folders ??= { ...prev.folders };
    folders[f.id] = { ...rec, listed: true };
  }
  let placements: Record<string, DocumentFolderPlacement> | null = null;
  for (const p of (Array.isArray(frame.documents) ? frame.documents : []) as DocumentFolderPlacement[]) {
    if (!p?.documentId) continue;
    const cur = prev.placements[p.documentId];
    if (cur && !cur.pending && cur.version >= p.version) continue;
    placements ??= { ...prev.placements };
    placements[p.documentId] = toPlacement(p);
  }
  if (!folders && !placements) return prev;
  return { folders: folders ?? prev.folders, placements: placements ?? prev.placements };
}

/** Merge one hub event into the picture; stale versions are ignored. Exported for tests. */
export function mergeDocumentFolderEvent(prev: State, event: Record<string, any>): State {
  return mergeEvent(prev, event);
}

function mergeEvent(prev: State, event: Record<string, any>): State {
  if (event.kind === 'folderUpserted' && event.folder?.id) {
    const f = event.folder as FolderRecord;
    const cur = prev.folders[f.id];
    if (cur && cur.version >= f.version) return prev;
    return { ...prev, folders: { ...prev.folders, [f.id]: { ...f, listed: cur?.listed } } };
  }
  if (event.kind === 'folderDeleted' && event.folderId) {
    if (!prev.folders[event.folderId]) return prev;
    const { [event.folderId]: _gone, ...rest } = prev.folders;
    return { ...prev, folders: rest };
  }
  if (event.kind === 'documentsMoved' && Array.isArray(event.moves)) {
    let placements: Record<string, DocumentFolderPlacement> | null = null;
    for (const m of event.moves as DocumentFolderPlacement[]) {
      const cur = prev.placements[m.documentId];
      // Only documents this viewer was shown; only newer versions.
      if (!cur || cur.version >= m.version) continue;
      placements ??= { ...prev.placements };
      placements[m.documentId] = toPlacement(m);
    }
    return placements ? { ...prev, placements } : prev;
  }
  return prev;
}
