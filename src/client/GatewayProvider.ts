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

import { Observable } from 'lib0/observable';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { toBase64, fromBase64 } from 'lib0/buffer';
// Type-only import — erased at build; the EC package stays a devDependency.
// Canonical outbound declarations: client.crdt.update / client.crdt.awareness.
import type { ClientFramePayload } from '@connorhoehn/event-catalog/client-frames';

export type SendMessage = (msg: Record<string, unknown>) => void;

export type DocumentPersistenceState = 'idle' | 'pending' | 'saved' | 'error';

export class GatewayProvider extends Observable<string> {
  readonly doc: Y.Doc;
  readonly channel: string;
  readonly awareness: Awareness;

  private readonly _sendMessage: SendMessage;
  private _synced = false;
  private _persistenceState: DocumentPersistenceState = 'idle';
  private _pendingUpdates = new Map<string, string>();
  private _sequence = 0;
  private _batch: Uint8Array[] = [];
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  /** Departure has been announced; nothing else leaves on the wire. */
  private _departed = false;
  private readonly _updateHandler: (update: Uint8Array, origin: unknown) => void;

  constructor(doc: Y.Doc, channel: string, sendMessage: SendMessage) {
    super();

    this.doc = doc;
    this.channel = channel;
    this._sendMessage = sendMessage;
    this.awareness = new Awareness(doc);

    // Listen for local document updates and forward deltas to the gateway.
    // Use `origin === this` guard to avoid echoing back remote updates.
    this._updateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      this._batch.push(update);
      this.setPersistenceState('pending');
      if (this._flushTimer) clearTimeout(this._flushTimer);
      this._flushTimer = setTimeout(() => this.flushUpdates(), 200);
    };
    this.doc.on('update', this._updateHandler);

    // Forward local awareness changes to the gateway (debounced to avoid flooding).
    this.awareness.on('update', ({ added, updated, removed }: {
      added: number[];
      updated: number[];
      removed: number[];
    }, origin: unknown) => {
      // Skip updates applied from remote (applyAwarenessUpdate uses `this` as origin)
      if (origin === this) return;
      // Gone: the departure went out synchronously in `announceDeparture`, and
      // a debounced frame after it would put the state back.
      if (this._departed) return;
      const changedClients = added.concat(updated, removed);
      // Only send if local client changed (not remote echoes)
      if (!changedClients.includes(this.awareness.clientID)) return;

      if (this._awarenessTimer) clearTimeout(this._awarenessTimer);
      this._awarenessTimer = setTimeout(() => {
        const encoded = encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]);
        const b64 = toBase64(encoded);
        // Pull `mode` and `idle` from the local awareness state so the gateway's
        // DocumentPresenceService can update without decoding the Y.js binary.
        const localUser = (this.awareness.getLocalState() as Record<string, unknown> | null)
          ?.user as Record<string, unknown> | undefined;
        const mode = typeof localUser?.mode === 'string' ? localUser.mode : undefined;
        const idle = typeof localUser?.idle === 'boolean' ? localUser.idle : undefined;
        // NOTE: canonical declaration is client.crdt.awareness, which narrows
        // `mode` to 'editor'|'reviewer'|'reader'. The client API surface
        // (useAwarenessState.updateMode) accepts any string, and this provider
        // forwards it verbatim — narrowing here would be a wire change, so the
        // frame stays Record-typed. Shape conformance is asserted in
        // test/contract/contract-conformance.test.ts instead.
        const msg: Record<string, unknown> = {
          service: 'crdt',
          action: 'awareness',
          channel: this.channel,
          update: b64,
        };
        if (mode !== undefined) msg.mode = mode;
        if (idle !== undefined) msg.idle = idle;
        this._sendMessage(msg);
      }, 50); // 50ms debounce — max 20 awareness updates/second
    });
  }

  get persistenceState(): DocumentPersistenceState { return this._persistenceState; }
  get pendingUpdateCount(): number { return this._pendingUpdates.size + (this._batch.length ? 1 : 0); }
  private setPersistenceState(state: DocumentPersistenceState): void {
    this._persistenceState = state;
    this.emit('persistence', [state, this.pendingUpdateCount]);
  }
  /** Flush an editing burst; IDs are echoed only after the snapshot store commits. */
  flushUpdates(): void {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    if (!this._batch.length) return;
    const updateId = `${this.doc.clientID}:${++this._sequence}`;
    const update = toBase64(Y.mergeUpdates(this._batch));
    this._batch = [];
    this._pendingUpdates.set(updateId, update);
    this.sendPending(updateId, update);
  }
  private sendPending(updateId: string, update: string): void {
    this.setPersistenceState('pending');
    try { this._sendMessage({ service: 'crdt', action: 'update', channel: this.channel, update, updateId }); }
    catch { this.setPersistenceState('error'); }
  }
  /** Idempotent Yjs updates can be resent after reconnect or an explicit retry. */
  retryPersistence(): void {
    this.flushUpdates();
    for (const [id, update] of this._pendingUpdates) this.sendPending(id, update);
  }
  /** Used after a server-authoritative replacement; callers retain recovery bytes separately. */
  discardPendingUpdates(): void {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    this._batch = [];
    this._pendingUpdates.clear();
    this.setPersistenceState('idle');
  }
  applyPersisted(updateId: string): void {
    if (!this._pendingUpdates.delete(updateId)) return;
    this.setPersistenceState(this.pendingUpdateCount ? 'pending' : 'saved');
  }
  applyPersistenceError(updateId: string): void {
    if (this._pendingUpdates.has(updateId)) this.setPersistenceState('error');
  }

  /** Whether we have received at least one snapshot from the server. */
  get synced(): boolean {
    return this._synced;
  }

  /**
   * Apply a remote Y.js document update received from the gateway.
   * Uses `this` as origin so the update handler above skips re-sending it.
   */
  applyRemoteUpdate(b64: string): void {
    const bytes = fromBase64(b64);
    Y.applyUpdate(this.doc, bytes, this);
  }

  /**
   * Apply the initial document snapshot from the server.
   * Functionally identical to applyRemoteUpdate but marks the provider as synced.
   */
  applySnapshot(b64: string): void {
    const bytes = fromBase64(b64);
    Y.applyUpdate(this.doc, bytes, this);
    this._synced = true;
    this.emit('synced', [true]);
    if (this.pendingUpdateCount) this.retryPersistence();
  }

  /**
   * Apply a remote awareness update received from the gateway.
   */
  applyAwarenessUpdate(b64: string): void {
    const bytes = fromBase64(b64);
    applyAwarenessUpdate(this.awareness, bytes, this);
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
  announceDeparture(): void {
    if (this._departed) return;
    this._departed = true;
    if (this._awarenessTimer) {
      clearTimeout(this._awarenessTimer);
      this._awarenessTimer = null;
    }
    const clientID = this.awareness.clientID;
    if (this.awareness.getLocalState() !== null) this.awareness.setLocalState(null);
    // A null state at a bumped clock: the receiver removes the client.
    const encoded = encodeAwarenessUpdate(this.awareness, [clientID]);
    this._sendMessage({
      service: 'crdt',
      action: 'awareness',
      channel: this.channel,
      update: toBase64(encoded),
    });
  }

  override destroy(): void {
    this.flushUpdates();
    this.doc.off('update', this._updateHandler);
    this.announceDeparture();
    this.awareness.destroy();
    super.destroy();
  }
}
