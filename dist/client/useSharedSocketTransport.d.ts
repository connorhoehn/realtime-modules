import type { UseWebSocketHookReturn, UseWebSocketOptions } from './useWebSocket';
import type { SharedSocketTransport, SharedSocketTransportOptions } from './sharedSocketTransport';
/** The socket a shared transport binds to: `useWebSocket()`'s return satisfies it. */
export interface SharedSocketBinding {
    send: (frame: Record<string, unknown>) => void;
    sessionEpoch?: number;
    /** When present, subscription frames wait for `'connected'`. */
    connectionState?: string;
}
export type UseSharedSocketTransportOptions = Pick<SharedSocketTransportOptions, 'scheduleRelease' | 'onHandlerError'>;
/**
 * A stable shared transport bound to `socket` (send, session epoch,
 * connection state). `null`/`undefined` unbinds: subscriptions are held and
 * re-sent when a socket is bound again. Inbound frames go to `transport.deliver`.
 */
export declare function useSharedSocketTransport(socket: SharedSocketBinding | null | undefined, options?: UseSharedSocketTransportOptions): SharedSocketTransport;
export interface UseSharedWebSocketResult {
    /** The `useWebSocket` return. `socket.sessionEpoch` is what to pass the pipeline hooks as `sessionEpoch`. */
    socket: UseWebSocketHookReturn;
    /** The shared transport over it. Stable. */
    transport: SharedSocketTransport;
}
/**
 * `useWebSocket` whose inbound frames fan out through a shared transport.
 * `options.onMessage`, when given, is called first for every frame.
 */
export declare function useSharedWebSocket(options: UseWebSocketOptions, transportOptions?: UseSharedSocketTransportOptions): UseSharedWebSocketResult;
//# sourceMappingURL=useSharedSocketTransport.d.ts.map