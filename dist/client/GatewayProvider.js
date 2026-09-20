"use strict";
// realtime-modules/src/client/GatewayProvider.ts
//
// Lifted verbatim from websocket-gateway frontend/src/providers/GatewayProvider.ts
// (Phase: CRDT Cut 1 — frontend lift). Editor-agnostic Y.js provider that bridges
// the gateway's message-based WS protocol. No Tiptap / ProseMirror dependencies.
//
// Wire protocol (outbound):
//   { service: 'crdt', action: 'update',    channel, update: <base64> }
//   { service: 'crdt', action: 'awareness', channel, update: <base64>,
//                                           mode?: 'editor'|'reviewer'|'reader',
//                                           idle?: boolean }
// `mode` and `idle` are extracted from awareness local state and forwarded
// as top-level frame fields so the server can update DocumentPresenceService
// without re-parsing the Y.js binary blob. CRDTService.handleAwareness
// destructures both with `typeof` guards and silently no-ops when absent.
//
// Wire protocol (inbound — applied via applyRemoteUpdate / applySnapshot /
// applyAwarenessUpdate by the orchestrating hook):
//   crdt:snapshot   { channel, snapshot:<base64> }
//   crdt:update     { channel, update:<base64> }
//   crdt:awareness  { channel, update:<base64> | updates:[{clientId,update}] }
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
exports.GatewayProvider = void 0;
const observable_1 = require("lib0/observable");
const Y = __importStar(require("yjs"));
const awareness_1 = require("y-protocols/awareness");
const buffer_1 = require("lib0/buffer");
class GatewayProvider extends observable_1.Observable {
    doc;
    channel;
    awareness;
    _sendMessage;
    _synced = false;
    _persistenceState = 'idle';
    _pendingUpdates = new Map();
    _sequence = 0;
    _batch = [];
    _flushTimer = null;
    _awarenessTimer = null;
    /** Departure has been announced; nothing else leaves on the wire. */
    _departed = false;
    _updateHandler;
    constructor(doc, channel, sendMessage) {
        super();
        this.doc = doc;
        this.channel = channel;
        this._sendMessage = sendMessage;
        this.awareness = new awareness_1.Awareness(doc);
        // Listen for local document updates and forward deltas to the gateway.
        // Use `origin === this` guard to avoid echoing back remote updates.
        this._updateHandler = (update, origin) => {
            if (origin === this)
                return;
            this._batch.push(update);
            this.setPersistenceState('pending');
            if (this._flushTimer)
                clearTimeout(this._flushTimer);
            this._flushTimer = setTimeout(() => this.flushUpdates(), 200);
        };
        this.doc.on('update', this._updateHandler);
        // Forward local awareness changes to the gateway (debounced to avoid flooding).
        this.awareness.on('update', ({ added, updated, removed }, origin) => {
            // Skip updates applied from remote (applyAwarenessUpdate uses `this` as origin)
            if (origin === this)
                return;
            // Gone: the departure went out synchronously in `announceDeparture`, and
            // a debounced frame after it would put the state back.
            if (this._departed)
                return;
            const changedClients = added.concat(updated, removed);
            // Only send if local client changed (not remote echoes)
            if (!changedClients.includes(this.awareness.clientID))
                return;
            if (this._awarenessTimer)
                clearTimeout(this._awarenessTimer);
            this._awarenessTimer = setTimeout(() => {
                const encoded = (0, awareness_1.encodeAwarenessUpdate)(this.awareness, [this.awareness.clientID]);
                const b64 = (0, buffer_1.toBase64)(encoded);
                // Pull `mode` and `idle` from the local awareness state so the gateway's
                // DocumentPresenceService can update without decoding the Y.js binary.
                const localUser = this.awareness.getLocalState()
                    ?.user;
                const mode = typeof localUser?.mode === 'string' ? localUser.mode : undefined;
                const idle = typeof localUser?.idle === 'boolean' ? localUser.idle : undefined;
                // NOTE: canonical declaration is client.crdt.awareness, which narrows
                // `mode` to 'editor'|'reviewer'|'reader'. The client API surface
                // (useAwarenessState.updateMode) accepts any string, and this provider
                // forwards it verbatim — narrowing here would be a wire change, so the
                // frame stays Record-typed. Shape conformance is asserted in
                // test/contract/contract-conformance.test.ts instead.
                const msg = {
                    service: 'crdt',
                    action: 'awareness',
                    channel: this.channel,
                    update: b64,
                };
                if (mode !== undefined)
                    msg.mode = mode;
                if (idle !== undefined)
                    msg.idle = idle;
                this._sendMessage(msg);
            }, 50); // 50ms debounce — max 20 awareness updates/second
        });
    }
    get persistenceState() { return this._persistenceState; }
    get pendingUpdateCount() { return this._pendingUpdates.size + (this._batch.length ? 1 : 0); }
    setPersistenceState(state) {
        this._persistenceState = state;
        this.emit('persistence', [state, this.pendingUpdateCount]);
    }
    /** Flush an editing burst; IDs are echoed only after the snapshot store commits. */
    flushUpdates() {
        if (this._flushTimer)
            clearTimeout(this._flushTimer);
        this._flushTimer = null;
        if (!this._batch.length)
            return;
        const updateId = `${this.doc.clientID}:${++this._sequence}`;
        const update = (0, buffer_1.toBase64)(Y.mergeUpdates(this._batch));
        this._batch = [];
        this._pendingUpdates.set(updateId, update);
        this.sendPending(updateId, update);
    }
    sendPending(updateId, update) {
        this.setPersistenceState('pending');
        try {
            this._sendMessage({ service: 'crdt', action: 'update', channel: this.channel, update, updateId });
        }
        catch {
            this.setPersistenceState('error');
        }
    }
    /** Idempotent Yjs updates can be resent after reconnect or an explicit retry. */
    retryPersistence() {
        this.flushUpdates();
        for (const [id, update] of this._pendingUpdates)
            this.sendPending(id, update);
    }
    /** Used after a server-authoritative replacement; callers retain recovery bytes separately. */
    discardPendingUpdates() {
        if (this._flushTimer)
            clearTimeout(this._flushTimer);
        this._flushTimer = null;
        this._batch = [];
        this._pendingUpdates.clear();
        this.setPersistenceState('idle');
    }
    applyPersisted(updateId) {
        if (!this._pendingUpdates.delete(updateId))
            return;
        this.setPersistenceState(this.pendingUpdateCount ? 'pending' : 'saved');
    }
    applyPersistenceError(updateId) {
        if (this._pendingUpdates.has(updateId))
            this.setPersistenceState('error');
    }
    /** Whether we have received at least one snapshot from the server. */
    get synced() {
        return this._synced;
    }
    /**
     * Apply a remote Y.js document update received from the gateway.
     * Uses `this` as origin so the update handler above skips re-sending it.
     */
    applyRemoteUpdate(b64) {
        const bytes = (0, buffer_1.fromBase64)(b64);
        Y.applyUpdate(this.doc, bytes, this);
    }
    /**
     * Apply the initial document snapshot from the server.
     * Functionally identical to applyRemoteUpdate but marks the provider as synced.
     */
    applySnapshot(b64) {
        const bytes = (0, buffer_1.fromBase64)(b64);
        Y.applyUpdate(this.doc, bytes, this);
        this._synced = true;
        this.emit('synced', [true]);
        if (this.pendingUpdateCount)
            this.retryPersistence();
    }
    /**
     * Apply a remote awareness update received from the gateway.
     */
    applyAwarenessUpdate(b64) {
        const bytes = (0, buffer_1.fromBase64)(b64);
        (0, awareness_1.applyAwarenessUpdate)(this.awareness, bytes, this);
    }
    /**
     * Tell the channel this client is gone — now, on the socket, before the
     * caller unsubscribes.
     *
     * Every other awareness change leaves through the 50ms debounce above. A
     * departure cannot: `useYjsDoc`'s cleanup sends the channel unsubscribe and
     * destroys the provider in the same tick, so the timer fired after the
     * socket had left the channel and the null state never reached anyone. The
     * others kept the last state — a person listed as "Editing" a document they
     * had left — until y-protocols' 30-second outdated sweep dropped it.
     * Measured live: 6s after leaving, still listed; gone at 36s.
     *
     * Idempotent; `destroy` calls it too, so a caller that forgets is covered as
     * long as it destroys before it unsubscribes.
     */
    announceDeparture() {
        if (this._departed)
            return;
        this._departed = true;
        if (this._awarenessTimer) {
            clearTimeout(this._awarenessTimer);
            this._awarenessTimer = null;
        }
        const clientID = this.awareness.clientID;
        if (this.awareness.getLocalState() !== null)
            this.awareness.setLocalState(null);
        // A null state at a bumped clock: the receiver removes the client.
        const encoded = (0, awareness_1.encodeAwarenessUpdate)(this.awareness, [clientID]);
        this._sendMessage({
            service: 'crdt',
            action: 'awareness',
            channel: this.channel,
            update: (0, buffer_1.toBase64)(encoded),
        });
    }
    destroy() {
        this.flushUpdates();
        this.doc.off('update', this._updateHandler);
        this.announceDeparture();
        this.awareness.destroy();
        super.destroy();
    }
}
exports.GatewayProvider = GatewayProvider;
//# sourceMappingURL=GatewayProvider.js.map