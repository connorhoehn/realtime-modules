import type { ConnectionState, GatewayMessage } from './types';
export interface UseCRDTOptions {
    sendMessage: (msg: Record<string, unknown>) => void;
    onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
    currentChannel: string;
    connectionState: ConnectionState;
}
export interface UseCRDTReturn {
    content: string;
    applyLocalEdit: (newText: string) => void;
    hasConflict: boolean;
    dismissConflict: () => void;
}
export declare function useCRDT(options: UseCRDTOptions): UseCRDTReturn;
//# sourceMappingURL=useCRDT.d.ts.map