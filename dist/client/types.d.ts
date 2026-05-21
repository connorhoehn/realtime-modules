export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export interface GatewayError {
    code: string;
    message: string;
    timestamp: string;
}
export interface GatewayMessage {
    type: string;
    action?: string;
    channel?: string;
    error?: GatewayError;
    [key: string]: unknown;
}
/**
 * Minimal WebSocket facade required by useYjsDoc.
 * Mirrors frontend's UseWebSocketReturn — feel free to satisfy structurally.
 */
export interface UseWebSocketReturn {
    connectionState: ConnectionState;
    lastError: GatewayError | null;
    sessionToken: string | null;
    clientId: string | null;
    currentChannel: string;
    switchChannel: (channel: string) => void;
    sendMessage: (msg: Record<string, unknown>) => void;
    disconnect: () => void;
    reconnect: () => void;
}
//# sourceMappingURL=types.d.ts.map