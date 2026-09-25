import type { GatewayMessage } from '../types';
export interface DocumentCallGateway {
    /** RM's GatewayContext calls it `send`… */
    send?: (msg: Record<string, unknown>) => void;
    /** …the app's WebSocketContext calls it `sendMessage`. Either works. */
    sendMessage?: (msg: Record<string, unknown>) => void;
    onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
    connectionState?: string;
    /** Bumps on every new gateway session; drives the reconnect re-sends. */
    sessionEpoch?: number;
}
export declare function useDocumentCallGateway(explicit?: DocumentCallGateway | null): DocumentCallGateway | null;
export declare function gatewaySend(gw: DocumentCallGateway | null, msg: Record<string, unknown>): void;
/** A `{ type:'call', action, data }` frame, or null. */
export declare function asCallFrame(msg: GatewayMessage): {
    action: string;
    data: Record<string, unknown>;
} | null;
//# sourceMappingURL=documentCallGateway.d.ts.map