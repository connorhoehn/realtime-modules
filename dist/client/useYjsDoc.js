"use strict";
// realtime-modules/src/client/useYjsDoc.ts
//
// Lifted verbatim from frontend/src/hooks/useYjsDoc.ts.
// Y.Doc + GatewayProvider lifecycle hook. Owns:
//  - Y.Doc creation/destruction
//  - GatewayProvider creation/destruction
//  - WS channel subscribe/unsubscribe + resubscribe on session
//  - Dispatch of incoming gateway messages (snapshot / update / awareness /
//    doc-replaced) onto the provider
//  - `synced` state
//
// It does NOT know about meta / sections / comments / awareness fields —
// those live in sibling hooks that observe the exposed `ydoc` / `provider`.
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
exports.useYjsDoc = useYjsDoc;
const react_1 = require("react");
const Y = __importStar(require("yjs"));
const GatewayProvider_1 = require("./GatewayProvider");
function useYjsDoc(options) {
    const { documentId, ws, onMessage, onDocReplaced } = options;
    const [synced, setSynced] = (0, react_1.useState)(false);
    const [docVersion, setDocVersion] = (0, react_1.useState)(0);
    const ydocRef = (0, react_1.useRef)(null);
    const providerRef = (0, react_1.useRef)(null);
    const onDocReplacedRef = (0, react_1.useRef)(onDocReplaced);
    onDocReplacedRef.current = onDocReplaced;
    // We need a stable getter for the channel (used by several effects).
    const channel = `doc:${documentId}`;
    // ---- Setup / teardown --------------------------------------------------
    (0, react_1.useEffect)(() => {
        const ydoc = new Y.Doc({ gc: false });
        ydocRef.current = ydoc;
        const provider = new GatewayProvider_1.GatewayProvider(ydoc, channel, ws.sendMessage);
        providerRef.current = provider;
        // Force a render so consumers see the non-null ydoc / provider.
        setDocVersion((v) => v + 1);
        // Subscribe to the channel (retry until WS is open)
        const sendSubscribe = () => {
            ws.sendMessage({
                service: 'crdt',
                action: 'subscribe',
                channel,
            });
        };
        sendSubscribe();
        const retryTimer = setTimeout(sendSubscribe, 500);
        const retryTimer2 = setTimeout(sendSubscribe, 1500);
        const onSynced = () => setSynced(true);
        provider.on('synced', onSynced);
        return () => {
            clearTimeout(retryTimer);
            clearTimeout(retryTimer2);
            ws.sendMessage({
                service: 'crdt',
                action: 'unsubscribe',
                channel,
            });
            const curProvider = providerRef.current;
            const curDoc = ydocRef.current;
            if (curProvider) {
                curProvider.off('synced', onSynced);
                curProvider.destroy();
            }
            if (curDoc) {
                curDoc.destroy();
            }
            ydocRef.current = null;
            providerRef.current = null;
            setSynced(false);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [documentId]);
    // ---- Re-subscribe on WebSocket reconnect (session message) --------------
    (0, react_1.useEffect)(() => {
        const unregister = onMessage((msg) => {
            if (msg.type === 'session') {
                ws.sendMessage({
                    service: 'crdt',
                    action: 'subscribe',
                    channel,
                });
            }
        });
        return unregister;
    }, [documentId, ws.sendMessage, onMessage, channel]);
    // ---- Handle incoming gateway messages (snapshot / update / awareness) ---
    (0, react_1.useEffect)(() => {
        const unregister = onMessage((msg) => {
            const provider = providerRef.current;
            if (!provider)
                return;
            // Server sends crdt:doc-replaced on version restore — destroy & rebuild
            // the Y.Doc so all observers pick up the fresh state cleanly.
            if (msg.type === 'crdt:doc-replaced') {
                if (msg.channel !== channel)
                    return;
                const snapshotB64 = msg.snapshot;
                if (!snapshotB64)
                    return;
                // Tear down old
                const oldDoc = ydocRef.current;
                const oldProvider = providerRef.current;
                if (oldProvider) {
                    oldProvider.off('synced', onSynced);
                    oldProvider.destroy();
                }
                if (oldDoc)
                    oldDoc.destroy();
                // Build fresh Y.Doc + provider
                const newDoc = new Y.Doc({ gc: false });
                ydocRef.current = newDoc;
                const newProvider = new GatewayProvider_1.GatewayProvider(newDoc, channel, ws.sendMessage);
                providerRef.current = newProvider;
                newProvider.applySnapshot(snapshotB64);
                newProvider.on('synced', onSynced);
                // Notify observers (sibling hooks) to re-attach.
                onDocReplacedRef.current?.(newDoc, newProvider);
                setSynced(true);
                setDocVersion((v) => v + 1);
                return;
            }
            if (msg.type === 'crdt:snapshot') {
                if (msg.channel !== channel)
                    return;
                const snapshotB64 = msg.snapshot;
                if (snapshotB64)
                    provider.applySnapshot(snapshotB64);
                return;
            }
            if (msg.type === 'crdt:update') {
                if (msg.channel !== channel)
                    return;
                const updateB64 = msg.update;
                if (updateB64)
                    provider.applyRemoteUpdate(updateB64);
                return;
            }
            if (msg.type === 'crdt:awareness') {
                if (msg.channel !== channel)
                    return;
                const raw = msg;
                const updates = raw.updates;
                if (updates && Array.isArray(updates)) {
                    for (const entry of updates) {
                        if (entry.update)
                            provider.applyAwarenessUpdate(entry.update);
                    }
                    return;
                }
                const updateB64 = raw.update;
                if (updateB64)
                    provider.applyAwarenessUpdate(updateB64);
                return;
            }
            if (msg.type === 'crdt') {
                if (msg.channel !== channel)
                    return;
                switch (msg.action) {
                    case 'snapshot':
                        if (msg['version'])
                            break;
                        if (msg['update']) {
                            provider.applySnapshot(msg['update']);
                        }
                        break;
                    case 'update':
                        if (msg['update']) {
                            provider.applyRemoteUpdate(msg['update']);
                        }
                        break;
                    case 'awareness':
                        if (msg['update']) {
                            provider.applyAwarenessUpdate(msg['update']);
                        }
                        break;
                }
            }
        });
        // Local synced handler for doc-replaced rebuild.
        function onSynced() {
            setSynced(true);
        }
        return unregister;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [documentId, onMessage]);
    return {
        ydoc: ydocRef.current,
        provider: providerRef.current,
        synced,
        docVersion,
    };
}
//# sourceMappingURL=useYjsDoc.js.map