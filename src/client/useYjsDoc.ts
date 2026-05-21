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

import { useState, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { GatewayProvider } from './GatewayProvider';
import type { UseWebSocketReturn, GatewayMessage } from './types';

export interface UseYjsDocOptions {
  documentId: string;
  ws: UseWebSocketReturn;
  onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
  /**
   * Optional callback fired when the server replaces the document
   * (e.g. via version restore) and we rebuild the Y.Doc + provider.
   * Consumers (observers in sibling hooks) can use it to re-attach.
   */
  onDocReplaced?: (ydoc: Y.Doc, provider: GatewayProvider) => void;
}

export interface UseYjsDocReturn {
  ydoc: Y.Doc | null;
  provider: GatewayProvider | null;
  synced: boolean;
  /**
   * Bumped every time the underlying Y.Doc / provider is recreated
   * (initial mount counts as 0). Sibling hooks can depend on this
   * to re-run their observer setup.
   */
  docVersion: number;
}

export function useYjsDoc(options: UseYjsDocOptions): UseYjsDocReturn {
  const { documentId, ws, onMessage, onDocReplaced } = options;

  const [synced, setSynced] = useState(false);
  const [docVersion, setDocVersion] = useState(0);

  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<GatewayProvider | null>(null);
  const onDocReplacedRef = useRef(onDocReplaced);
  onDocReplacedRef.current = onDocReplaced;

  // We need a stable getter for the channel (used by several effects).
  const channel = `doc:${documentId}`;

  // ---- Setup / teardown --------------------------------------------------
  useEffect(() => {
    const ydoc = new Y.Doc({ gc: false });
    ydocRef.current = ydoc;

    const provider = new GatewayProvider(ydoc, channel, ws.sendMessage);
    providerRef.current = provider;

    // Force a render so consumers see the non-null ydoc / provider.
    setDocVersion((v) => v + 1);

    // Subscribe to the channel (retry until WS is open)
    const sendSubscribe = () => {
      ws.sendMessage({ service: 'crdt', action: 'subscribe', channel });
    };
    sendSubscribe();
    const retryTimer = setTimeout(sendSubscribe, 500);
    const retryTimer2 = setTimeout(sendSubscribe, 1500);

    const onSynced = () => setSynced(true);
    provider.on('synced', onSynced);

    return () => {
      clearTimeout(retryTimer);
      clearTimeout(retryTimer2);

      ws.sendMessage({ service: 'crdt', action: 'unsubscribe', channel });

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
  useEffect(() => {
    const unregister = onMessage((msg: GatewayMessage) => {
      if (msg.type === 'session') {
        ws.sendMessage({ service: 'crdt', action: 'subscribe', channel });
      }
    });
    return unregister;
  }, [documentId, ws.sendMessage, onMessage, channel]);

  // ---- Handle incoming gateway messages (snapshot / update / awareness) ---
  useEffect(() => {
    const unregister = onMessage((msg: GatewayMessage) => {
      const provider = providerRef.current;
      if (!provider) return;

      // Server sends crdt:doc-replaced on version restore — destroy & rebuild
      // the Y.Doc so all observers pick up the fresh state cleanly.
      if (msg.type === 'crdt:doc-replaced') {
        if (msg.channel !== channel) return;
        const snapshotB64 = (msg as Record<string, unknown>).snapshot as
          | string
          | undefined;
        if (!snapshotB64) return;

        // Tear down old
        const oldDoc = ydocRef.current;
        const oldProvider = providerRef.current;
        if (oldProvider) {
          oldProvider.off('synced', onSynced);
          oldProvider.destroy();
        }
        if (oldDoc) oldDoc.destroy();

        // Build fresh Y.Doc + provider
        const newDoc = new Y.Doc({ gc: false });
        ydocRef.current = newDoc;
        const newProvider = new GatewayProvider(newDoc, channel, ws.sendMessage);
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
        if (msg.channel !== channel) return;
        const snapshotB64 = (msg as Record<string, unknown>).snapshot as
          | string
          | undefined;
        if (snapshotB64) provider.applySnapshot(snapshotB64);
        return;
      }

      if (msg.type === 'crdt:update') {
        if (msg.channel !== channel) return;
        const updateB64 = (msg as Record<string, unknown>).update as
          | string
          | undefined;
        if (updateB64) provider.applyRemoteUpdate(updateB64);
        return;
      }

      if (msg.type === 'crdt:awareness') {
        if (msg.channel !== channel) return;
        const raw = msg as Record<string, unknown>;
        const updates = raw.updates as
          | Array<{ clientId: string; update: string }>
          | undefined;
        if (updates && Array.isArray(updates)) {
          for (const entry of updates) {
            if (entry.update) provider.applyAwarenessUpdate(entry.update);
          }
          return;
        }
        const updateB64 = raw.update as string | undefined;
        if (updateB64) provider.applyAwarenessUpdate(updateB64);
        return;
      }

      if (msg.type === 'crdt') {
        if (msg.channel !== channel) return;
        switch (msg.action) {
          case 'snapshot':
            if (msg['version']) break;
            if (msg['update']) {
              provider.applySnapshot(msg['update'] as string);
            }
            break;
          case 'update':
            if (msg['update']) {
              provider.applyRemoteUpdate(msg['update'] as string);
            }
            break;
          case 'awareness':
            if (msg['update']) {
              provider.applyAwarenessUpdate(msg['update'] as string);
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
