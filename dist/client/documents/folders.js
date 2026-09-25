"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.positionBetween = positionBetween;
exports.deriveDocumentFolders = deriveDocumentFolders;
exports.useDocumentFolders = useDocumentFolders;
exports.documentFolderSignalReads = documentFolderSignalReads;
exports.mergeDocumentFolderRead = mergeDocumentFolderRead;
exports.mergeDocumentFolderEvent = mergeDocumentFolderEvent;
const react_1 = require("react");
const transport_1 = require("./transport");
const SERVICE = 'document-folders';
/** A position strictly between two neighbours (either may be missing), for drag-reorder. */
function positionBetween(before, after) {
    const b = typeof before === 'number' && Number.isFinite(before) ? before : undefined;
    const a = typeof after === 'number' && Number.isFinite(after) ? after : undefined;
    if (b === undefined && a === undefined)
        return 1;
    if (b === undefined)
        return a - 1;
    if (a === undefined)
        return b + 1;
    return (b + a) / 2;
}
function newRequestId() {
    const c = globalThis.crypto;
    return c?.randomUUID ? c.randomUUID() : `rq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
/** A placement off the wire, keeping only known fields (trash state included). */
function toPlacement(p) {
    return {
        documentId: p.documentId, folderId: p.folderId ?? null, position: p.position, version: p.version,
        ...(typeof p.trashedAt === 'string' ? { trashedAt: p.trashedAt } : {}),
        ...(typeof p.trashedAt === 'string' && typeof p.trashedBy === 'string' ? { trashedBy: p.trashedBy } : {}),
    };
}
/** Folder + ancestors, cycle-safe. */
function ancestry(folders, folderId) {
    const out = [];
    const seen = new Set();
    let cur = folderId ?? null;
    while (cur && folders[cur] && !seen.has(cur)) {
        seen.add(cur);
        out.push(cur);
        cur = folders[cur].parentFolderId;
    }
    return out;
}
/** Pure derivation of the visible tree and counts — exported for tests and non-React callers. */
function deriveDocumentFolders(state, currentUserId) {
    const count = {};
    const direct = {};
    const docsIn = {};
    const unfiled = [];
    const trashed = [];
    for (const p of Object.values(state.placements)) {
        const fid = p.folderId && state.folders[p.folderId] ? p.folderId : null;
        if (p.trashedAt) {
            trashed.push({ documentId: p.documentId, trashedAt: p.trashedAt, ...(p.trashedBy ? { trashedBy: p.trashedBy } : {}), folderId: fid });
            continue;
        }
        if (!fid) {
            unfiled.push(p);
            continue;
        }
        direct[fid] = (direct[fid] ?? 0) + 1;
        (docsIn[fid] ??= []).push(p);
        for (const id of ancestry(state.folders, fid))
            count[id] = (count[id] ?? 0) + 1;
    }
    const visible = new Set();
    for (const f of Object.values(state.folders)) {
        if (f.listed || (count[f.id] ?? 0) > 0 || (currentUserId && f.createdBy === currentUserId)) {
            for (const id of ancestry(state.folders, f.id))
                visible.add(id);
        }
    }
    const bySort = (a, b) => a.position - b.position || String(a.name ?? a.documentId).localeCompare(String(b.name ?? b.documentId));
    const folders = [...visible].map((id) => {
        const { listed: _listed, ...f } = state.folders[id];
        return { ...f, count: count[id] ?? 0, directCount: direct[id] ?? 0 };
    }).sort(bySort);
    const nodes = {};
    for (const f of folders)
        nodes[f.id] = { ...f, depth: 0, children: [], documentIds: (docsIn[f.id] ?? []).sort(bySort).map((p) => p.documentId) };
    const tree = [];
    for (const f of folders) {
        const parent = f.parentFolderId ? nodes[f.parentFolderId] : undefined;
        if (parent)
            parent.children.push(nodes[f.id]);
        else
            tree.push(nodes[f.id]);
    }
    const setDepth = (list, depth) => { for (const n of list) {
        n.depth = depth;
        setDepth(n.children, depth + 1);
    } };
    setDepth(tree, 0);
    trashed.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt) || a.documentId.localeCompare(b.documentId));
    return { folders, tree, unfiled: unfiled.sort(bySort).map((p) => p.documentId), trashed, totalCount: Object.keys(state.placements).length - trashed.length };
}
function useDocumentFolders(options = {}) {
    const { transport, sessionEpoch, enabled = true, currentUserId, timeoutMs = 10_000 } = options;
    const { send, onMessage, epoch } = (0, transport_1.useResolvedTransport)(transport, sessionEpoch);
    const active = enabled && !!send && !!onMessage;
    const [state, setState] = (0, react_1.useState)({ folders: {}, placements: {} });
    const [loading, setLoading] = (0, react_1.useState)(active);
    const [error, setError] = (0, react_1.useState)(undefined);
    const pending = (0, react_1.useRef)(new Map());
    const stateRef = (0, react_1.useRef)(state);
    stateRef.current = state;
    const sendRef = (0, react_1.useRef)(send);
    sendRef.current = send;
    // Signals waiting to be re-read, coalesced into one `read` per tick.
    const rereadRef = (0, react_1.useRef)({ folderIds: new Set(), documentIds: new Set(), timer: null });
    const flushReread = (0, react_1.useCallback)(() => {
        const q = rereadRef.current;
        q.timer = null;
        const folderIds = [...q.folderIds];
        const documentIds = [...q.documentIds];
        q.folderIds.clear();
        q.documentIds.clear();
        if (!folderIds.length && !documentIds.length)
            return;
        try {
            sendRef.current?.({ service: SERVICE, action: 'read', requestId: newRequestId(), folderIds, documentIds });
        }
        catch { /* socket gone; the next subscribe heals */ }
    }, []);
    (0, react_1.useEffect)(() => () => { const q = rereadRef.current; if (q.timer)
        clearTimeout(q.timer); q.timer = null; }, []);
    // Inbound frames: the list, mutation answers, hub events, and the CRDT
    // service's own create/delete broadcasts (a new document starts Unfiled).
    (0, react_1.useEffect)(() => {
        if (!active || !onMessage)
            return undefined;
        return onMessage((raw) => {
            const frame = raw;
            if (!frame || typeof frame !== 'object')
                return;
            if (frame.type === 'document-folders:list') {
                const folders = {};
                for (const f of (frame.folders ?? [])) {
                    const { count: _c, directCount: _d, ...rec } = f;
                    folders[f.id] = { ...rec, listed: true };
                }
                const placements = {};
                for (const p of (frame.documents ?? []))
                    if (p?.documentId)
                        placements[p.documentId] = toPlacement(p);
                setState({ folders, placements });
                setLoading(false);
                return;
            }
            if (frame.type === 'document-folders:result') {
                const entry = typeof frame.requestId === 'string' ? pending.current.get(frame.requestId) : undefined;
                if (frame.action === 'list' || frame.action === 'subscribe') {
                    if (!frame.ok) {
                        setError(frame);
                        setLoading(false);
                    }
                }
                if (!entry)
                    return;
                pending.current.delete(frame.requestId);
                clearTimeout(entry.timer);
                const result = frame;
                entry.onSettle?.(result);
                setError(result.ok ? undefined : result);
                entry.resolve(result);
                return;
            }
            if (frame.type === 'document-folders:event') {
                const ask = documentFolderSignalReads(stateRef.current, frame);
                if (ask) {
                    for (const id of ask.folderIds)
                        rereadRef.current.folderIds.add(id);
                    for (const id of ask.documentIds)
                        rereadRef.current.documentIds.add(id);
                    if (!rereadRef.current.timer)
                        rereadRef.current.timer = setTimeout(flushReread, 0);
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
                    if (!prev.placements[id])
                        return prev;
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
    (0, react_1.useEffect)(() => {
        if (!active || !send)
            return undefined;
        setLoading(true);
        if (epoch === 0)
            return undefined;
        send({ service: SERVICE, action: 'subscribe', requestId: newRequestId() });
        return () => { try {
            send({ service: SERVICE, action: 'unsubscribe' });
        }
        catch { /* socket already gone */ } };
    }, [active, send, epoch]);
    // Unanswered requests fail rather than hang when the hook unmounts.
    (0, react_1.useEffect)(() => () => {
        for (const [requestId, entry] of pending.current) {
            clearTimeout(entry.timer);
            entry.resolve({ ok: false, requestId, code: 'disconnected', message: 'Folders view closed' });
        }
        pending.current.clear();
    }, []);
    const request = (0, react_1.useCallback)((action, body, onSettle) => {
        const requestId = newRequestId();
        const s = sendRef.current;
        if (!active || !s) {
            const r = { ok: false, requestId, code: 'disconnected', message: 'Not connected' };
            onSettle?.(r);
            return Promise.resolve(r);
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pending.current.delete(requestId);
                const r = { ok: false, requestId, code: 'timeout', message: 'No answer from the gateway' };
                onSettle?.(r);
                setError(r);
                resolve(r);
            }, timeoutMs);
            pending.current.set(requestId, { resolve, timer, onSettle });
            s({ service: SERVICE, action, requestId, ...body });
        });
    }, [active, timeoutMs]);
    const expectedVersionOf = (folderId) => stateRef.current.folders[folderId]?.version ?? 1;
    const upsertFromResult = (0, react_1.useCallback)((r) => {
        if (r.ok && r.folder)
            setState((prev) => mergeEvent(prev, { kind: 'folderUpserted', folder: r.folder }));
        if (r.ok && r.folderId && !r.folder)
            setState((prev) => mergeEvent(prev, { kind: 'folderDeleted', folderId: r.folderId }));
    }, []);
    const createFolder = (0, react_1.useCallback)((input) => request('createFolder', { name: input.name, parentFolderId: input.parentFolderId ?? null, ...(input.position !== undefined ? { position: input.position } : {}) }, upsertFromResult), [request, upsertFromResult]);
    const renameFolder = (0, react_1.useCallback)((folderId, name) => request('renameFolder', { folderId, name, expectedVersion: expectedVersionOf(folderId) }, upsertFromResult), [request, upsertFromResult]);
    const moveFolder = (0, react_1.useCallback)((folderId, parentFolderId, position) => request('moveFolder', { folderId, parentFolderId, expectedVersion: expectedVersionOf(folderId), ...(position !== undefined ? { position } : {}) }, upsertFromResult), [request, upsertFromResult]);
    const deleteFolder = (0, react_1.useCallback)((folderId) => request('deleteFolder', { folderId, expectedVersion: expectedVersionOf(folderId) }, upsertFromResult), [request, upsertFromResult]);
    const moveDocuments = (0, react_1.useCallback)((moves) => {
        const before = {};
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
                    if (now && !now.pending && settled && now.version > settled.version)
                        continue;
                    if (settled)
                        placements[m.documentId] = toPlacement({ ...settled, documentId: m.documentId });
                    else
                        delete placements[m.documentId];
                }
                return { ...prev, placements };
            });
        });
    }, [request]);
    const moveDocument = (0, react_1.useCallback)((documentId, folderId, position) => moveDocuments([{ documentId, folderId, ...(position !== undefined ? { position } : {}) }]), [moveDocuments]);
    const setTrash = (0, react_1.useCallback)((documentIds, trashed) => {
        const ids = [...new Set(documentIds.filter((id) => typeof id === 'string' && id))];
        const before = {};
        for (const id of ids)
            before[id] = stateRef.current.placements[id];
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
                    if (now && !now.pending && settled && now.version > settled.version)
                        continue;
                    if (settled)
                        placements[id] = toPlacement({ ...settled, documentId: id });
                    else
                        delete placements[id];
                }
                return { ...prev, placements };
            });
        });
    }, [request, currentUserId]);
    const trashDocuments = (0, react_1.useCallback)((documentIds) => setTrash(documentIds, true), [setTrash]);
    const restoreDocuments = (0, react_1.useCallback)((documentIds) => setTrash(documentIds, false), [setTrash]);
    const isTrashed = (0, react_1.useCallback)((documentId) => !!state.placements[documentId]?.trashedAt, [state.placements]);
    const refresh = (0, react_1.useCallback)(() => {
        if (active && sendRef.current)
            sendRef.current({ service: SERVICE, action: 'list', requestId: newRequestId() });
    }, [active]);
    const derived = (0, react_1.useMemo)(() => deriveDocumentFolders(state, currentUserId), [state, currentUserId]);
    const folderOf = (0, react_1.useCallback)((documentId) => {
        const fid = state.placements[documentId]?.folderId ?? null;
        return fid && state.folders[fid] ? fid : null;
    }, [state]);
    const byId = (0, react_1.useMemo)(() => new Map(derived.folders.map((f) => [f.id, f])), [derived.folders]);
    const pathOf = (0, react_1.useCallback)((folderId) => ancestry(state.folders, folderId).reverse().map((id) => byId.get(id)).filter((f) => !!f), [state.folders, byId]);
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
function documentFolderSignalReads(prev, event) {
    const folderIds = new Set();
    const documentIds = new Set();
    if (event.kind === 'folderUpserted' && !event.folder && typeof event.folderId === 'string') {
        const cur = prev.folders[event.folderId];
        if (cur && typeof event.version === 'number' && cur.version >= event.version)
            return { folderIds: [], documentIds: [] };
        folderIds.add(event.folderId);
        for (const id of ancestry(prev.folders, cur?.parentFolderId))
            folderIds.add(id);
    }
    else if (event.kind === 'documentsMoved' && !Array.isArray(event.moves) && Array.isArray(event.documentIds)) {
        const versions = Array.isArray(event.versions) ? event.versions : [];
        event.documentIds.forEach((raw, i) => {
            if (typeof raw !== 'string')
                return;
            const cur = prev.placements[raw];
            const v = versions[i];
            if (cur && !cur.pending && typeof v === 'number' && cur.version >= v)
                return;
            documentIds.add(raw);
            // Where it was: that folder may now be empty for this viewer.
            for (const id of ancestry(prev.folders, cur?.folderId))
                folderIds.add(id);
        });
    }
    else {
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
function mergeDocumentFolderRead(prev, frame) {
    let folders = null;
    const hidden = Array.isArray(frame.hiddenFolderIds) ? frame.hiddenFolderIds.filter((x) => typeof x === 'string') : [];
    if (hidden.length) {
        const gone = new Set(hidden);
        const all = Object.values(prev.folders);
        // A hidden folder hides its subtree (a visible folder's ancestors are always visible).
        for (let grew = true; grew;) {
            grew = false;
            for (const f of all)
                if (!gone.has(f.id) && f.parentFolderId && gone.has(f.parentFolderId)) {
                    gone.add(f.id);
                    grew = true;
                }
        }
        for (const id of gone) {
            if (!prev.folders[id])
                continue;
            folders ??= { ...prev.folders };
            delete folders[id];
        }
    }
    for (const f of (Array.isArray(frame.folders) ? frame.folders : [])) {
        if (!f?.id)
            continue;
        const cur = (folders ?? prev.folders)[f.id];
        if (cur && cur.version > f.version)
            continue;
        const { count: _c, directCount: _d, ...rec } = f;
        folders ??= { ...prev.folders };
        folders[f.id] = { ...rec, listed: true };
    }
    let placements = null;
    for (const p of (Array.isArray(frame.documents) ? frame.documents : [])) {
        if (!p?.documentId)
            continue;
        const cur = prev.placements[p.documentId];
        if (cur && !cur.pending && cur.version >= p.version)
            continue;
        placements ??= { ...prev.placements };
        placements[p.documentId] = toPlacement(p);
    }
    if (!folders && !placements)
        return prev;
    return { folders: folders ?? prev.folders, placements: placements ?? prev.placements };
}
/** Merge one hub event into the picture; stale versions are ignored. Exported for tests. */
function mergeDocumentFolderEvent(prev, event) {
    return mergeEvent(prev, event);
}
function mergeEvent(prev, event) {
    if (event.kind === 'folderUpserted' && event.folder?.id) {
        const f = event.folder;
        const cur = prev.folders[f.id];
        if (cur && cur.version >= f.version)
            return prev;
        return { ...prev, folders: { ...prev.folders, [f.id]: { ...f, listed: cur?.listed } } };
    }
    if (event.kind === 'folderDeleted' && event.folderId) {
        if (!prev.folders[event.folderId])
            return prev;
        const { [event.folderId]: _gone, ...rest } = prev.folders;
        return { ...prev, folders: rest };
    }
    if (event.kind === 'documentsMoved' && Array.isArray(event.moves)) {
        let placements = null;
        for (const m of event.moves) {
            const cur = prev.placements[m.documentId];
            // Only documents this viewer was shown; only newer versions.
            if (!cur || cur.version >= m.version)
                continue;
            placements ??= { ...prev.placements };
            placements[m.documentId] = toPlacement(m);
        }
        return placements ? { ...prev, placements } : prev;
    }
    return prev;
}
//# sourceMappingURL=folders.js.map