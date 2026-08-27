"use strict";
// realtime-modules/src/adapters/excalidraw/ExcalidrawYjsBinding.ts
//
// Binds an Excalidraw scene to a Y.Doc. Framework-free: no React, no DOM, no
// Excalidraw import. It is the same shape as the `y-excalidraw` community
// binding, rewritten against this project's structural-typing rule and against
// Excalidraw 0.18 (which we could not use `y-excalidraw` with anyway — it
// peer-pins `@excalidraw/excalidraw ^0.17.6`).
//
// ---------------------------------------------------------------------------
// Why a keyed Y.Map and not a Y.Array
// ---------------------------------------------------------------------------
// The obvious model is `Y.Array<Y.Map>` where array order is z-order. That
// forces you to diff and replay reorders, which is where the community
// bindings get their bug reports.
//
// Excalidraw 0.17 moved z-order onto the element itself as a fractional index
// (`element.index`, e.g. "a1"). Once ordering is a property, it merges like any
// other property and the container can be an unordered keyed map:
//
//   root: Y.Map
//     └── "elements": Y.Map<elementId, Y.Map<propName, jsonValue>>
//
// Read = collect values, sort by `index`. That is conflict-free by
// construction: two users reordering different shapes never touch the same
// key, and two users reordering the SAME shape land on per-property LWW, which
// is exactly what Excalidraw itself does.
//
// ---------------------------------------------------------------------------
// Granularity
// ---------------------------------------------------------------------------
// One Y.Map PER ELEMENT (not one JSON blob per element) is the whole point.
// Two people dragging two different shapes write disjoint keys and both edits
// survive. Two people dragging the same shape collide only on `x`/`y`. If the
// element were a single serialized value, every concurrent edit anywhere in the
// scene would be a whole-element clobber.
//
// ---------------------------------------------------------------------------
// Deletes
// ---------------------------------------------------------------------------
// Tombstones (`isDeleted: true`), never key removal. Excalidraw's own scene
// model keeps deleted elements around for undo, and a real removal races badly
// with a concurrent edit — delete-wins vs. resurrect has no good answer, while
// a tombstone is just another LWW property.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExcalidrawYjsBinding = exports.DEFAULT_DIAGRAM_ROOT = void 0;
exports.diagramRootName = diagramRootName;
const Y = __importStar(require("yjs"));
/** Y.Map key holding the per-element maps. */
const ELEMENTS_KEY = 'elements';
/** Default root type name on the Y.Doc. */
exports.DEFAULT_DIAGRAM_ROOT = 'excalidraw';
/** Root-type name for a diagram block inside a page-level Y.Doc. */
function diagramRootName(blockId) {
    return `${exports.DEFAULT_DIAGRAM_ROOT}:${blockId}`;
}
/**
 * Two-way binding between an Excalidraw element list and a Y.Doc subtree.
 *
 * Transport is not this class's problem. Whatever provider owns the Y.Doc
 * (here: `GatewayProvider`, base64 over the gateway's JSON WebSocket frames)
 * ships the updates; the binding only ever touches the document.
 */
class ExcalidrawYjsBinding {
    ydoc;
    rootName;
    _root;
    _elements;
    /**
     * Last element state this binding wrote or observed, keyed by element id.
     * Lets `commitLocal` skip untouched elements without deep comparison.
     */
    _stamps = new Map();
    _observers = new Set();
    _deepHandler;
    _destroyed = false;
    constructor(options) {
        this.ydoc = options.ydoc;
        this.rootName = options.rootName ?? exports.DEFAULT_DIAGRAM_ROOT;
        this._root = this.ydoc.getMap(this.rootName);
        let elements = this._root.get(ELEMENTS_KEY);
        if (!elements) {
            // Two clients opening a cold diagram simultaneously both run this.
            // Yjs resolves the concurrent `set` of two fresh Y.Maps by keeping
            // one; the loser's map is detached and its (empty) contents are
            // dropped, which is harmless because it is empty at this instant.
            elements = new Y.Map();
            this._root.set(ELEMENTS_KEY, elements);
            elements = this._root.get(ELEMENTS_KEY);
        }
        this._elements = elements;
        this._deepHandler = (_events, txn) => {
            // Skip our own writes — `commitLocal` transacts with `this` as the
            // origin, so this is how the echo loop is broken.
            if (txn.origin === this)
                return;
            const snapshot = this.readAll();
            // Adopt remote stamps so the next commitLocal does not re-send
            // what we just received.
            for (const el of snapshot) {
                this._stamps.set(el.id, {
                    version: el.version,
                    versionNonce: el.versionNonce,
                });
            }
            for (const cb of this._observers)
                cb(snapshot);
        };
        this._elements.observeDeep(this._deepHandler);
    }
    /** Number of elements currently in the shared scene, tombstones included. */
    get size() {
        return this._elements.size;
    }
    /**
     * Read the whole scene out of the Y.Doc, sorted into z-order.
     *
     * Sort is by the fractional `index` string (lexicographic — that is the
     * ordering fractional indices are designed for). Elements with no index
     * (pre-0.17 scenes, or an element mid-creation) sort last, tie-broken by
     * id so the result is deterministic across peers.
     */
    readAll() {
        const out = [];
        this._elements.forEach((ymap) => {
            const obj = ymap.toJSON();
            if (obj && typeof obj.id === 'string')
                out.push(obj);
        });
        out.sort((a, b) => {
            const ai = typeof a.index === 'string' ? a.index : '￿';
            const bi = typeof b.index === 'string' ? b.index : '￿';
            if (ai !== bi)
                return ai < bi ? -1 : 1;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        return out;
    }
    /**
     * Push the local scene into the Y.Doc.
     *
     * Call this from Excalidraw's `onChange`. It is cheap on the common path:
     * elements whose `version`/`versionNonce` are unchanged since the last
     * commit are skipped without touching their properties at all.
     *
     * Returns `true` when anything was actually written.
     */
    commitLocal(elements) {
        if (this._destroyed)
            return false;
        let wrote = false;
        const seen = new Set();
        this.ydoc.transact(() => {
            for (const el of elements) {
                if (!el || typeof el.id !== 'string')
                    continue;
                seen.add(el.id);
                const stamp = this._stamps.get(el.id);
                const existing = this._elements.get(el.id);
                if (existing &&
                    stamp &&
                    stamp.version === el.version &&
                    stamp.versionNonce === el.versionNonce) {
                    continue; // untouched since we last looked
                }
                if (!existing) {
                    const ymap = new Y.Map();
                    for (const [k, v] of Object.entries(el)) {
                        if (v !== undefined)
                            ymap.set(k, v);
                    }
                    this._elements.set(el.id, ymap);
                    wrote = true;
                }
                else if (this._applyProps(existing, el)) {
                    wrote = true;
                }
                this._stamps.set(el.id, {
                    version: el.version,
                    versionNonce: el.versionNonce,
                });
            }
            // Anything we previously knew about that has vanished from the
            // local scene entirely gets tombstoned. (Excalidraw normally hands
            // us deleted elements with `isDeleted: true` still in the array,
            // so this is the belt-and-braces path for hosts that filter.)
            for (const id of this._stamps.keys()) {
                if (seen.has(id))
                    continue;
                const ymap = this._elements.get(id);
                if (ymap && ymap.get('isDeleted') !== true) {
                    ymap.set('isDeleted', true);
                    wrote = true;
                }
            }
        }, this);
        return wrote;
    }
    /**
     * Subscribe to remote changes. The callback fires with the full sorted
     * scene and NEVER fires for this binding's own `commitLocal` writes.
     */
    observe(callback) {
        this._observers.add(callback);
        return () => {
            this._observers.delete(callback);
        };
    }
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._elements.unobserveDeep(this._deepHandler);
        this._observers.clear();
        this._stamps.clear();
    }
    // -- internals ----------------------------------------------------------
    /** Write only the properties that actually differ. Returns true if any did. */
    _applyProps(ymap, el) {
        let wrote = false;
        for (const [k, v] of Object.entries(el)) {
            if (v === undefined)
                continue;
            if (!valuesEqual(ymap.get(k), v)) {
                ymap.set(k, v);
                wrote = true;
            }
        }
        // A property the local element dropped (e.g. `boundElements` cleared)
        // must be removed, or the remote value resurrects on the next read.
        for (const k of Array.from(ymap.keys())) {
            if (!(k in el) || el[k] === undefined) {
                ymap.delete(k);
                wrote = true;
            }
        }
        return wrote;
    }
}
exports.ExcalidrawYjsBinding = ExcalidrawYjsBinding;
/**
 * Structural equality for element property values.
 *
 * Excalidraw properties are JSON: scalars, arrays of points, `groupIds`,
 * `boundElements`, `customData`. `Object.is` covers the scalar majority in one
 * comparison; only the handful of object-valued properties fall through to a
 * stringify, and only for elements whose version already changed.
 */
function valuesEqual(a, b) {
    if (Object.is(a, b))
        return true;
    if (a === null || b === null)
        return false;
    if (typeof a !== 'object' || typeof b !== 'object')
        return false;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=ExcalidrawYjsBinding.js.map