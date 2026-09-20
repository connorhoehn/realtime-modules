import { Observable } from 'lib0/observable';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
export type SendMessage = (msg: Record<string, unknown>) => void;
export type DocumentPersistenceState = 'idle' | 'pending' | 'saved' | 'error';
export declare class GatewayProvider extends Observable<string> {
    readonly doc: Y.Doc;
    readonly channel: string;
    readonly awareness: Awareness;
    private readonly _sendMessage;
    private _synced;
    private _persistenceState;
    private _pendingUpdates;
    private _sequence;
    private _batch;
    private _flushTimer;
    private _awarenessTimer;
    /** Departure has been announced; nothing else leaves on the wire. */
    private _departed;
    private readonly _updateHandler;
    constructor(doc: Y.Doc, channel: string, sendMessage: SendMessage);
    get persistenceState(): DocumentPersistenceState;
    get pendingUpdateCount(): number;
    private setPersistenceState;
    /** Flush an editing burst; IDs are echoed only after the snapshot store commits. */
    flushUpdates(): void;
    private sendPending;
    /** Idempotent Yjs updates can be resent after reconnect or an explicit retry. */
    retryPersistence(): void;
    applyPersisted(updateId: string): void;
    applyPersistenceError(updateId: string): void;
    /** Whether we have received at least one snapshot from the server. */
    get synced(): boolean;
    /**
     * Apply a remote Y.js document update received from the gateway.
     * Uses `this` as origin so the update handler above skips re-sending it.
     */
    applyRemoteUpdate(b64: string): void;
    /**
     * Apply the initial document snapshot from the server.
     * Functionally identical to applyRemoteUpdate but marks the provider as synced.
     */
    applySnapshot(b64: string): void;
    /**
     * Apply a remote awareness update received from the gateway.
     */
    applyAwarenessUpdate(b64: string): void;
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
    announceDeparture(): void;
    destroy(): void;
}
//# sourceMappingURL=GatewayProvider.d.ts.map