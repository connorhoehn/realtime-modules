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
export declare function useYjsDoc(options: UseYjsDocOptions): UseYjsDocReturn;
//# sourceMappingURL=useYjsDoc.d.ts.map