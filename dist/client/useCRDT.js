"use strict";
// realtime-modules/src/client/useCRDT.ts
//
// Lifted verbatim from frontend/src/hooks/useCRDT.ts.
// CRDT hook — subscribes to the gateway CRDT service, applies incoming Y.js
// binary updates to a shared Y.Doc, broadcasts local edits encoded as base64
// Y.js updates, and restores document state from a DynamoDB snapshot when
// (re)connecting.
//
// Composes on top of useWebSocket: accepts sendMessage / onMessage from that
// hook and handles the CRDT protocol independently.
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
exports.useCRDT = useCRDT;
const react_1 = require("react");
const Y = __importStar(require("yjs"));
const yjs_1 = require("yjs");
// Browser-compatible base64 helpers (no Node.js Buffer)
function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        bytes[i] = bin.charCodeAt(i);
    return bytes;
}
function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++)
        bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
function useCRDT(options) {
    const { sendMessage, onMessage, currentChannel, connectionState } = options;
    // ---- State ---------------------------------------------------------------
    const [content, setContent] = (0, react_1.useState)('');
    const [hasConflict, setHasConflict] = (0, react_1.useState)(false);
    // ---- Y.Doc refs ----------------------------------------------------------
    // Y.Doc lives in a ref — stable across renders, one doc per hook instance.
    // Use a lazy initializer via useState to avoid reading refs during render.
    const [ydocInstance] = (0, react_1.useState)(() => new Y.Doc());
    const ydoc = (0, react_1.useRef)(ydocInstance);
    const [ytextInstance] = (0, react_1.useState)(() => ydocInstance.getText('content'));
    const ytext = (0, react_1.useRef)(ytextInstance);
    // ---- Stable refs for closures --------------------------------------------
    const sendMessageRef = (0, react_1.useRef)(sendMessage);
    (0, react_1.useEffect)(() => {
        sendMessageRef.current = sendMessage;
    }, [sendMessage]);
    const currentChannelRef = (0, react_1.useRef)(currentChannel);
    (0, react_1.useEffect)(() => {
        currentChannelRef.current = currentChannel;
    }, [currentChannel]);
    // ---- onMessage handler ---------------------------------------------------
    // Separate effect from subscribe so the handler survives channel changes
    // without being torn down. Channel filtering uses currentChannelRef so
    // closures always read the freshest channel.
    (0, react_1.useEffect)(() => {
        const unregister = onMessage((msg) => {
            if (msg.type === 'crdt:snapshot') {
                // Only process snapshots for the current channel
                if (msg.channel !== currentChannelRef.current)
                    return;
                const snapshotB64 = msg.snapshot;
                if (!snapshotB64)
                    return;
                try {
                    const bytes = b64ToBytes(snapshotB64);
                    (0, yjs_1.applyUpdate)(ydoc.current, bytes);
                    setContent(ytext.current.toString());
                }
                catch {
                    // Malformed snapshot — leave doc empty
                }
                return;
            }
            if (msg.type === 'crdt:update') {
                // Only process updates for the current channel
                if (msg.channel !== currentChannelRef.current)
                    return;
                const updateB64 = msg.update;
                if (!updateB64)
                    return;
                try {
                    const bytes = b64ToBytes(updateB64);
                    (0, yjs_1.applyUpdate)(ydoc.current, bytes);
                    setContent(ytext.current.toString());
                }
                catch {
                    // Malformed update — ignore
                }
                return;
            }
        });
        return unregister;
    }, [onMessage]);
    // ---- Subscribe / unsubscribe on connect / channel change -----------------
    (0, react_1.useEffect)(() => {
        // Guard: only subscribe when connected and channel is set
        if (connectionState !== 'connected' || !currentChannel) {
            return;
        }
        // Reset Y.Doc on each new subscription so stale state from the previous
        // channel or session is cleared. Register a fresh observer on the new doc.
        setHasConflict(false); // eslint-disable-line react-hooks/set-state-in-effect
        ydoc.current.destroy();
        ydoc.current = new Y.Doc();
        ytext.current = ydoc.current.getText('content');
        ytext.current.observe(() => setContent(ytext.current.toString()));
        setContent('');
        // CRDT-03: Detect merge conflicts via afterTransaction
        // A "conflict" is when a remote transaction modifies a doc that already has local content.
        ydoc.current.on('afterTransaction', (transaction) => {
            // Only flag remote transactions (origin !== null means remote in Y.js)
            if (transaction.origin !== null && ytext.current.length > 0) {
                setHasConflict(true);
            }
        });
        // CRDT-02 Reconnect Recovery Flow:
        // 1. connectionState transitions to 'connected' (reconnect or initial)
        // 2. Y.Doc is destroyed and recreated (clean slate)
        // 3. Subscribe message sent to gateway
        // 4. Gateway responds with 'crdt:subscribed' confirmation
        // 5. Gateway pushes latest snapshot via 'crdt:snapshot' if one exists
        // 6. onMessage handler (line 64) applies snapshot to fresh Y.Doc
        // 7. Subsequent real-time crdt:update messages apply normally
        sendMessage({ service: 'crdt', action: 'subscribe', channel: currentChannel });
        // Cleanup: unsubscribe when channel changes or unmounts
        return () => {
            sendMessageRef.current({
                service: 'crdt',
                action: 'unsubscribe',
                channel: currentChannel,
            });
            setContent('');
        };
    }, [currentChannel, connectionState]); // eslint-disable-line react-hooks/exhaustive-deps
    // sendMessage intentionally excluded — we use sendMessageRef for stable access.
    // ---- dismissConflict() --------------------------------------------------
    const dismissConflict = (0, react_1.useCallback)(() => {
        setHasConflict(false);
    }, []);
    // ---- applyLocalEdit() ---------------------------------------------------
    // Stable callback — accesses current channel and sendMessage via refs.
    // Performs a Y.js transact (delete + insert) to replace full content,
    // then encodes the full doc state as a base64 update for the gateway.
    const applyLocalEdit = (0, react_1.useCallback)((newText) => {
        ydoc.current.transact(() => {
            ytext.current.delete(0, ytext.current.length);
            ytext.current.insert(0, newText);
        });
        const update = (0, yjs_1.encodeStateAsUpdate)(ydoc.current);
        const b64 = bytesToB64(update);
        sendMessageRef.current({
            service: 'crdt',
            action: 'update',
            channel: currentChannelRef.current,
            update: b64,
        });
    }, []);
    // All deps accessed via refs — stable callback that never causes re-renders
    return { content, applyLocalEdit, hasConflict, dismissConflict };
}
//# sourceMappingURL=useCRDT.js.map