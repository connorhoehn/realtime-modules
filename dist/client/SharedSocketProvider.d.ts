import React from 'react';
import type { ReactNode } from 'react';
import type { ConnectionState } from './types';
import type { UseWebSocketOptions } from './useWebSocket';
import type { SharedSocketTransport } from './sharedSocketTransport';
import type { UseSharedSocketTransportOptions } from './useSharedSocketTransport';
export interface SharedSocketContextValue {
    /** The shared transport. Stable, and present while the socket is down: holds made then are sent on connect. */
    transport: SharedSocketTransport;
    /** The socket's connection state. `'connected'` when the host gave none. */
    connectionState: ConnectionState;
    /** `connectionState === 'connected'`: frames can arrive. A channel's own answer is `transport.channelState(channel)`. */
    live: boolean;
    /** The socket's session epoch, when it tracks one. */
    sessionEpoch?: number;
}
/** The nearest SharedSocketProvider's value, or null outside one. */
export declare function useSharedSocket(): SharedSocketContextValue | null;
/** What a host-owned socket gives the provider: `useWebSocket()`'s return satisfies it. */
export interface SharedSocketStatus {
    connectionState?: ConnectionState;
    sessionEpoch?: number;
}
export type SharedSocketProviderProps = {
    children?: ReactNode;
} & ({
    /** Own the socket: `useSharedWebSocket(options, transportOptions)`. `options.onMessage` sees every frame first. */
    options: UseWebSocketOptions;
    transportOptions?: UseSharedSocketTransportOptions;
    socket?: never;
    transport?: never;
    fromGateway?: never;
} | {
    /** A host-owned socket's state (`useSharedWebSocket().socket`). */
    socket: SharedSocketStatus;
    /** Its transport (`useSharedWebSocket().transport`). */
    transport: SharedSocketTransport;
    options?: never;
    transportOptions?: never;
    fromGateway?: never;
} | {
    /** Bridge the nearest GatewaySocketProvider's socket. */
    fromGateway: true;
    transportOptions?: UseSharedSocketTransportOptions;
    options?: never;
    socket?: never;
    transport?: never;
});
/** One shared socket transport in context; see the file header for the three modes and the precedence. */
export declare function SharedSocketProvider(props: SharedSocketProviderProps): React.ReactElement;
//# sourceMappingURL=SharedSocketProvider.d.ts.map