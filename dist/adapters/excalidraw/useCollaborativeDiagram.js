"use strict";
// realtime-modules/src/adapters/excalidraw/useCollaborativeDiagram.ts
//
// The hook a host app (or a ui-components composite) consumes to make an
// Excalidraw canvas collaborative. It owns the binding lifecycle and the
// awareness read/write for presence — and nothing else.
//
// ---------------------------------------------------------------------------
// It does not create a Y.Doc, a provider, or a socket
// ---------------------------------------------------------------------------
// Those already exist and are already generic: `useYjsDoc` + `GatewayProvider`
// in `./client`, `CRDTService` + `SnapshotManager` in `./server`. That stack is
// schema-agnostic — it applies opaque Yjs updates and snapshots opaque Yjs
// state — so a diagram inherits transport, snapshots, hot cache, idle
// eviction, cross-node fan-out and authz without one line of new sync code.
// Nothing here is diagram-specific except the shape of the data.
//
// ---------------------------------------------------------------------------
// Awareness: a sibling key, never nested under `user`
// ---------------------------------------------------------------------------
// `useAwarenessState` is the single writer of the `user` awareness field and
// flushes it as a WHOLE OBJECT, so anything merged into `user` from elsewhere
// gets clobbered on the next identity change. Presence therefore lives under a
// top-level `diagram` key, exactly as document carets live under `cursor` and
// call state lives under `call`.
//
// This reuses the ONE awareness channel the document editor already uses. No
// second presence path, no second socket. And it stays on the JSON-envelope
// wire the gateway forces: `GatewayProvider` base64s the awareness update into
// a string field, because the gateway coerces every frame to UTF-8 and a
// binary awareness protocol cannot survive that.
//
// ---------------------------------------------------------------------------
// One record, merged locally, written whole
// ---------------------------------------------------------------------------
// `setLocalStateField` REPLACES the value at a key. Every writer therefore has
// to supply the complete record, which is what `_presenceRef` below is for.
// Publishing partial records is not a style question — it actively destroyed
// presence, and is documented on `DiagramPresence` in ./types.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DIAGRAM_AWARENESS_KEY = void 0;
exports.useCollaborativeDiagram = useCollaborativeDiagram;
const react_1 = require("react");
const ExcalidrawYjsBinding_1 = require("./ExcalidrawYjsBinding");
/** Awareness top-level key. Sibling of `user` / `cursor` / `call`. */
exports.DIAGRAM_AWARENESS_KEY = 'diagram';
/**
 * Pointer publish interval — 50ms, i.e. 20 frames/second.
 *
 * Chosen to MATCH the transport rather than to be as fast as possible:
 * `GatewayProvider` debounces its awareness send by 50ms, so a local write
 * faster than this cannot produce a faster wire rate — the extra writes are
 * coalesced away before they reach the socket and only cost React renders.
 *
 * The ceiling above is the gateway's 60 crdt-frames/second per client. Pointer
 * frames are one of three things sharing that budget on a document page (text
 * carets and document updates are the others), so taking a third of it is the
 * point. 20fps is also roughly where a moving cursor stops reading as stepped
 * — below ~15 it visibly stutters, above ~25 nobody can tell.
 *
 * Leading-edge with a trailing flush: the first move of a gesture publishes
 * immediately (so a cursor never lags into motion) and the last one is never
 * dropped (so a cursor never parks a frame short of where it stopped).
 */
const POINTER_THROTTLE_MS = 50;
/**
 * Liveness heartbeat — republish presence this often even when nothing moved.
 *
 * 4s is 0.25 frames/second, which is noise next to the pointer budget, and it
 * gives three chances to be heard before `PRESENCE_STALE_MS` expires.
 */
const HEARTBEAT_MS = 4_000;
/**
 * Drop a peer whose presence has not been refreshed in this long.
 *
 * ## Why this exists at all
 *
 * Nothing tells us promptly that a peer is gone. The gateway does NOT broadcast
 * an awareness removal when a socket drops — `CRDTService.onClientDisconnect`
 * clears `presenceService` and the awareness coalescer's buffer, both of which
 * are its OWN bookkeeping, and never emits a frame to the remaining clients.
 *
 * So on a hard tab close the departed client's state simply sits in every
 * surviving peer's `awareness.getStates()` until y-protocols' internal sweep
 * notices, and that sweep runs on a hard-coded 30s `outdatedTimeout`. Half a
 * minute of a dead cursor and a dead avatar is not "presence".
 *
 * A clean unmount (SPA navigation, closing the block) still clears instantly
 * via the effect cleanup below — the socket is alive, so the null publish gets
 * out. This timeout is only the backstop for the case where it cannot.
 *
 * ## Why 12s, and why it is measured locally
 *
 * Three missed heartbeats. Two is within normal jitter for a debounced,
 * coalesced, server-fanned-out frame; three is a real absence.
 *
 * Staleness is measured against the LOCAL clock from when a peer's record last
 * *changed*, never by comparing their `t` to our `Date.now()`. Two browsers on
 * two machines have no shared clock, and a few seconds of skew either way would
 * otherwise evict a live peer or keep a dead one forever.
 */
const PRESENCE_STALE_MS = 12_000;
/** Collaborator-list recompute coalesce window. Keeps React renders bounded. */
const COLLAB_COALESCE_MS = 60;
const DEFAULT_COLOR = '#3b82f6';
function useCollaborativeDiagram(options) {
    const { ydoc, awareness, blockId, user, onRemoteElements } = options;
    const rootName = blockId ? (0, ExcalidrawYjsBinding_1.diagramRootName)(blockId) : ExcalidrawYjsBinding_1.DEFAULT_DIAGRAM_ROOT;
    const scopeId = blockId ?? ExcalidrawYjsBinding_1.DEFAULT_DIAGRAM_ROOT;
    const [binding, setBinding] = (0, react_1.useState)(null);
    const [collaborators, setCollaborators] = (0, react_1.useState)([]);
    const onRemoteRef = (0, react_1.useRef)(onRemoteElements);
    onRemoteRef.current = onRemoteElements;
    // ---- Binding lifecycle -------------------------------------------------
    (0, react_1.useEffect)(() => {
        if (!ydoc) {
            setBinding(null);
            return;
        }
        const b = new ExcalidrawYjsBinding_1.ExcalidrawYjsBinding({ ydoc, rootName });
        setBinding(b);
        const unobserve = b.observe((elements) => {
            onRemoteRef.current?.(elements);
        });
        return () => {
            unobserve();
            b.destroy();
            setBinding(null);
        };
    }, [ydoc, rootName]);
    // ---- Local identity ----------------------------------------------------
    // Held as a stable primitive triple so the publish effects below do not
    // re-fire on every render just because the caller built a fresh object.
    const userId = user?.userId;
    const displayName = user?.displayName ?? 'Anonymous';
    const color = user?.color || DEFAULT_COLOR;
    const identity = (0, react_1.useMemo)(() => ({ displayName, color, ...(userId ? { userId } : {}) }), [displayName, color, userId]);
    // Read through a ref by everything that publishes, so identity is never a
    // dependency of an effect that TEARS DOWN presence. See the announce
    // effect below for what that cost.
    const identityRef = (0, react_1.useRef)(identity);
    // ---- The local presence record -----------------------------------------
    // The single source of truth for what we publish. Patches merge into this;
    // the whole thing goes onto awareness. See the header note.
    const presenceRef = (0, react_1.useRef)({ blockId: scopeId, user: identity });
    const lastSentAtRef = (0, react_1.useRef)(0);
    const flushTimerRef = (0, react_1.useRef)(null);
    const dirtyRef = (0, react_1.useRef)(false);
    const awarenessRef = (0, react_1.useRef)(awareness);
    awarenessRef.current = awareness;
    /** Write the CURRENT record to awareness. Always the complete object. */
    const flush = (0, react_1.useCallback)(() => {
        flushTimerRef.current = null;
        const aw = awarenessRef.current;
        if (!aw)
            return;
        dirtyRef.current = false;
        lastSentAtRef.current = Date.now();
        const record = { ...presenceRef.current, t: lastSentAtRef.current };
        presenceRef.current = record;
        aw.setLocalStateField(exports.DIAGRAM_AWARENESS_KEY, record);
    }, []);
    const publishPresence = (0, react_1.useCallback)((patch) => {
        if (!awarenessRef.current)
            return;
        // Merge, never replace. The whole point.
        presenceRef.current = {
            ...presenceRef.current,
            ...patch,
            blockId: scopeId,
            user: identityRef.current,
        };
        dirtyRef.current = true;
        const since = Date.now() - lastSentAtRef.current;
        if (since >= POINTER_THROTTLE_MS) {
            if (flushTimerRef.current) {
                clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
            }
            flush();
            return;
        }
        if (flushTimerRef.current)
            return; // trailing flush already queued
        flushTimerRef.current = setTimeout(flush, POINTER_THROTTLE_MS - since);
    }, [flush, scopeId]);
    // ---- Announce on arrival, then heartbeat -------------------------------
    //
    // The announce is not a nicety. Presence used to be published ONLY from the
    // pointer and change handlers, so a peer who opened the board and did not
    // touch their mouse existed on nobody's screen — the participant list was
    // empty until everyone wiggled. Publishing on mount is what makes "who is
    // here" answer the question it is asking.
    //
    // The heartbeat then keeps that record fresh so peers can tell "idle" from
    // "gone"; see PRESENCE_STALE_MS for why nothing else can tell them.
    // ## Why identity is NOT a dependency here
    //
    // It was, and the cleanup below resets the presence record — so every time
    // the host's identity settled (a display name arriving a beat after mount,
    // a colour resolving) this effect tore down and rebuilt, and a live pointer
    // was silently wiped in between. Caught on the document surface, where the
    // page re-renders far more than a standalone board does: a peer's record
    // arrived carrying `selectedElementIds` with `pointer: undefined`, which is
    // the same broken picture the whole-record clobber used to produce.
    //
    // Identity now updates through `identityRef` in its own non-destructive
    // effect, and this one turns over only when the CHANNEL does.
    (0, react_1.useEffect)(() => {
        identityRef.current = identity;
        if (!awarenessRef.current)
            return;
        // Republish so peers relabel immediately — merged, so a pointer or
        // selection in flight survives the rename.
        presenceRef.current = { ...presenceRef.current, user: identity };
        flush();
    }, [identity, flush]);
    (0, react_1.useEffect)(() => {
        if (!awareness)
            return;
        presenceRef.current = {
            ...presenceRef.current,
            blockId: scopeId,
            user: identityRef.current,
        };
        flush();
        const beat = setInterval(flush, HEARTBEAT_MS);
        return () => {
            clearInterval(beat);
            if (flushTimerRef.current) {
                clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
            }
            // Clean exit: on an unmount the socket is still up, so this null
            // reaches peers within a frame and the cursor goes at once. Only a
            // hard tab close has to wait for the staleness sweep.
            try {
                awareness.setLocalStateField(exports.DIAGRAM_AWARENESS_KEY, null);
            }
            catch {
                /* provider already destroyed — nothing to clear */
            }
            presenceRef.current = { blockId: scopeId, user: identityRef.current };
            lastSentAtRef.current = 0;
        };
    }, [awareness, scopeId, flush]);
    // ---- Reading peers off awareness ---------------------------------------
    (0, react_1.useEffect)(() => {
        if (!awareness) {
            setCollaborators([]);
            return;
        }
        const sightings = new Map();
        let timer = null;
        const recompute = () => {
            timer = null;
            const now = Date.now();
            const next = [];
            const live = new Set();
            awareness.getStates().forEach((state, clientId) => {
                if (clientId === awareness.clientID)
                    return;
                const diagram = state?.[exports.DIAGRAM_AWARENESS_KEY];
                if (!diagram || diagram.blockId !== scopeId)
                    return;
                live.add(clientId);
                // Liveness by local clock. A peer is "seen" whenever their
                // record CHANGES; the heartbeat guarantees it changes every
                // HEARTBEAT_MS while they are connected.
                let sig;
                try {
                    sig = JSON.stringify(diagram);
                }
                catch {
                    sig = String(diagram.t ?? '');
                }
                const prior = sightings.get(clientId);
                if (!prior || prior.sig !== sig) {
                    sightings.set(clientId, { sig, at: now });
                }
                else if (
                // Only peers that actually heartbeat are held to the
                // deadline. A client on an older build never sends `t`, and
                // evicting it at 12s would invent an absence that is not
                // real — it falls back to y-protocols' own 30s sweep.
                typeof diagram.t === 'number' &&
                    now - prior.at > PRESENCE_STALE_MS) {
                    return;
                }
                // Identity: `user` first. In a DOCUMENT `useAwarenessState`
                // owns that field and fills it from the app's real identity, so
                // it is the better answer. On the STANDALONE board there is no
                // useAwarenessState at all and the field does not exist, which
                // is why the diagram record carries its own copy to fall back
                // to — without it every peer on a board renders "Anonymous" in
                // the same default blue.
                const peer = (state?.user ?? {});
                const self = diagram.user;
                next.push({
                    clientId: String(clientId),
                    userId: (typeof peer.userId === 'string' && peer.userId) ||
                        self?.userId ||
                        undefined,
                    displayName: (typeof peer.displayName === 'string' && peer.displayName) ||
                        (typeof peer.name === 'string' && peer.name) ||
                        self?.displayName ||
                        'Anonymous',
                    color: (typeof peer.color === 'string' && peer.color) ||
                        self?.color ||
                        DEFAULT_COLOR,
                    pointer: diagram.pointer,
                    button: diagram.button,
                    selectedElementIds: diagram.selectedElementIds,
                    viewport: diagram.viewport,
                });
            });
            // Forget peers that left, so the map cannot grow without bound
            // across a long session of joins and departures.
            for (const id of Array.from(sightings.keys())) {
                if (!live.has(id))
                    sightings.delete(id);
            }
            setCollaborators((prev) => (sameCollaborators(prev, next) ? prev : next));
        };
        const schedule = () => {
            if (timer)
                return;
            timer = setTimeout(recompute, COLLAB_COALESCE_MS);
        };
        recompute();
        awareness.on('change', schedule);
        // A departure produces NO awareness event — that is the whole problem
        // PRESENCE_STALE_MS solves — so the deadline needs its own clock.
        const sweep = setInterval(recompute, HEARTBEAT_MS);
        return () => {
            awareness.off('change', schedule);
            clearInterval(sweep);
            if (timer)
                clearTimeout(timer);
        };
    }, [awareness, scopeId]);
    const participants = (0, react_1.useMemo)(() => [
        {
            clientId: awareness ? String(awareness.clientID) : 'local',
            displayName,
            color,
            isSelf: true,
            ...(userId ? { userId } : {}),
        },
        ...collaborators,
    ], [awareness, collaborators, displayName, color, userId]);
    const commitLocal = (0, react_1.useCallback)((elements) => {
        binding?.commitLocal(elements);
    }, [binding]);
    const readAll = (0, react_1.useCallback)(() => binding?.readAll() ?? [], [binding]);
    return (0, react_1.useMemo)(() => ({
        binding,
        ready: binding !== null,
        collaborators,
        participants,
        commitLocal,
        publishPresence,
        readAll,
    }), [binding, collaborators, participants, commitLocal, publishPresence, readAll]);
}
/**
 * Cheap identity check for the collaborator list.
 *
 * The sweep runs every HEARTBEAT_MS whether or not anything changed, and each
 * peer heartbeat is an awareness event. Returning the previous array when
 * nothing meaningful moved keeps those ticks from re-rendering the whole canvas
 * host and, more to the point, from pushing an identical collaborator map into
 * Excalidraw several times a second.
 */
function sameCollaborators(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (x.clientId !== y.clientId ||
            x.displayName !== y.displayName ||
            x.color !== y.color ||
            x.button !== y.button ||
            x.pointer?.x !== y.pointer?.x ||
            x.pointer?.y !== y.pointer?.y ||
            x.pointer?.tool !== y.pointer?.tool ||
            // Without this a pure scroll or zoom — no pointer movement — is
            // judged "no change" and never reaches a follower, which is the
            // exact case follow mode exists to cover.
            x.viewport?.scrollX !== y.viewport?.scrollX ||
            x.viewport?.scrollY !== y.viewport?.scrollY ||
            x.viewport?.zoom !== y.viewport?.zoom) {
            return false;
        }
        const xs = x.selectedElementIds;
        const ys = y.selectedElementIds;
        if (xs !== ys) {
            const xk = xs ? Object.keys(xs) : [];
            const yk = ys ? Object.keys(ys) : [];
            if (xk.length !== yk.length)
                return false;
            for (const k of xk)
                if (!ys || !ys[k])
                    return false;
        }
    }
    return true;
}
//# sourceMappingURL=useCollaborativeDiagram.js.map