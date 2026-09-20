import * as Y from 'yjs';
import { GatewayProvider, type DocumentPersistenceState } from './GatewayProvider';
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
    /** A remote restore replaced unacknowledged local edits; retain/export these bytes for recovery. */
    onUnpersistedChanges?: (snapshot: Uint8Array) => void;
}
export interface UseYjsDocReturn {
    ydoc: Y.Doc | null;
    provider: GatewayProvider | null;
    synced: boolean;
    persistenceState: DocumentPersistenceState;
    pendingUpdateCount: number;
    retryPersistence: () => void;
    recoverySnapshot: Uint8Array | null;
    /**
     * Bumped every time the underlying Y.Doc / provider is recreated
     * (initial mount counts as 0). Sibling hooks can depend on this
     * to re-run their observer setup.
     */
    docVersion: number;
}
export declare function useYjsDoc(options: UseYjsDocOptions): UseYjsDocReturn;
//# sourceMappingURL=useYjsDoc.d.ts.map