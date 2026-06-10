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

import { useState, useEffect, useRef, useCallback } from 'react';
import * as Y from 'yjs';
import { encodeStateAsUpdate, applyUpdate } from 'yjs';
import type { ConnectionState, GatewayMessage } from './types';
// Type-only import — erased at build; the EC package stays a devDependency.
import type { ClientFramePayload } from '@connorhoehn/event-catalog/client-frames';

// Browser-compatible base64 helpers (no Node.js Buffer)
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UseCRDTOptions {
  sendMessage: (msg: Record<string, unknown>) => void;
  onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
  currentChannel: string;
  connectionState: ConnectionState;
}

export interface UseCRDTReturn {
  content: string;                        // Current Y.Text content as plain string (reactive)
  applyLocalEdit: (newText: string) => void;  // Called by editor on user input
  hasConflict: boolean;                   // True when a remote transaction merges into existing doc content
  dismissConflict: () => void;            // Resets hasConflict to false
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCRDT(options: UseCRDTOptions): UseCRDTReturn {
  const { sendMessage, onMessage, currentChannel, connectionState } = options;

  // ---- State ---------------------------------------------------------------
  const [content, setContent] = useState<string>('');
  const [hasConflict, setHasConflict] = useState<boolean>(false);

  // ---- Y.Doc refs ----------------------------------------------------------
  // Y.Doc lives in a ref — stable across renders, one doc per hook instance.
  // Use a lazy initializer via useState to avoid reading refs during render.
  const [ydocInstance] = useState(() => new Y.Doc());
  const ydoc = useRef<Y.Doc>(ydocInstance);
  const [ytextInstance] = useState(() => ydocInstance.getText('content'));
  const ytext = useRef<Y.Text>(ytextInstance);

  // ---- Stable refs for closures --------------------------------------------
  const sendMessageRef = useRef(sendMessage);
  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  const currentChannelRef = useRef(currentChannel);
  useEffect(() => {
    currentChannelRef.current = currentChannel;
  }, [currentChannel]);

  // ---- onMessage handler ---------------------------------------------------
  // Separate effect from subscribe so the handler survives channel changes
  // without being torn down. Channel filtering uses currentChannelRef so
  // closures always read the freshest channel.
  useEffect(() => {
    const unregister = onMessage((msg: GatewayMessage) => {
      if (msg.type === 'crdt:snapshot') {
        // Only process snapshots for the current channel
        if (msg.channel !== currentChannelRef.current) return;

        const snapshotB64 = msg.snapshot as string | undefined;
        if (!snapshotB64) return;

        try {
          const bytes = b64ToBytes(snapshotB64);
          applyUpdate(ydoc.current, bytes);
          setContent(ytext.current.toString());
        } catch {
          // Malformed snapshot — leave doc empty
        }
        return;
      }

      if (msg.type === 'crdt:update') {
        // Only process updates for the current channel
        if (msg.channel !== currentChannelRef.current) return;

        const updateB64 = msg.update as string | undefined;
        if (!updateB64) return;

        try {
          const bytes = b64ToBytes(updateB64);
          applyUpdate(ydoc.current, bytes);
          setContent(ytext.current.toString());
        } catch {
          // Malformed update — ignore
        }
        return;
      }
    });

    return unregister;
  }, [onMessage]);

  // ---- Subscribe / unsubscribe on connect / channel change -----------------
  useEffect(() => {
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
    ydoc.current.on('afterTransaction', (transaction: Y.Transaction) => {
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
    sendMessage({
      service: 'crdt',
      action: 'subscribe',
      channel: currentChannel,
    } satisfies ClientFramePayload<'client.crdt.subscribe'>);

    // Cleanup: unsubscribe when channel changes or unmounts
    return () => {
      sendMessageRef.current({
        service: 'crdt',
        action: 'unsubscribe',
        channel: currentChannel,
      } satisfies ClientFramePayload<'client.crdt.unsubscribe'>);
      setContent('');
    };
  }, [currentChannel, connectionState]); // eslint-disable-line react-hooks/exhaustive-deps
  // sendMessage intentionally excluded — we use sendMessageRef for stable access.

  // ---- dismissConflict() --------------------------------------------------
  const dismissConflict = useCallback(() => {
    setHasConflict(false);
  }, []);

  // ---- applyLocalEdit() ---------------------------------------------------
  // Stable callback — accesses current channel and sendMessage via refs.
  // Performs a Y.js transact (delete + insert) to replace full content,
  // then encodes the full doc state as a base64 update for the gateway.
  const applyLocalEdit = useCallback((newText: string) => {
    ydoc.current.transact(() => {
      ytext.current.delete(0, ytext.current.length);
      ytext.current.insert(0, newText);
    });
    const update = encodeStateAsUpdate(ydoc.current);
    const b64 = bytesToB64(update);
    sendMessageRef.current({
      service: 'crdt',
      action: 'update',
      channel: currentChannelRef.current,
      update: b64,
    } satisfies ClientFramePayload<'client.crdt.update'>);
  }, []);
  // All deps accessed via refs — stable callback that never causes re-renders

  return { content, applyLocalEdit, hasConflict, dismissConflict };
}
