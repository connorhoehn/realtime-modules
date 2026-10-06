import type { WorkGraphClientTransport } from './useWorkGraph';
/**
 * The slice of a realtime connection the work-graph stream needs.
 * `useGateway()` (inside `GatewaySocketProvider`) satisfies it.
 */
export interface WorkGraphGatewayConnection {
    send(frame: Record<string, unknown>): void;
    onMessage(handler: (message: any) => void): () => void;
}
export interface WorkGraphGatewayTransportOptions {
    gateway: WorkGraphGatewayConnection;
    /** The authorized snapshot read (the host's HTTP route). */
    fetchSnapshot: WorkGraphClientTransport['fetchSnapshot'];
    /**
     * When provided and false, opening a stream fails immediately so the hook
     * retries with backoff instead of waiting on a frame that was never sent.
     */
    isConnected?: () => boolean;
    /** Wire service name. Default `work-graph` (the `workGraph()` feature). */
    service?: string;
}
/**
 * A `WorkGraphClientTransport` over the realtime socket, speaking the
 * `workGraph()` server feature's protocol (0.108). The hook is unchanged: it
 * still fetches its snapshot first, then opens the stream from the snapshot's
 * cursor; stream messages are handed to it verbatim.
 *
 * A dropped or replaced socket (a new `session` frame) and a subscribe
 * refusal end the stream through `onClose` / `onError`,
 * so the hook recovers through a fresh snapshot. `close()` unsubscribes.
 */
export declare function createWorkGraphGatewayTransport(options: WorkGraphGatewayTransportOptions): WorkGraphClientTransport;
//# sourceMappingURL=gatewayTransport.d.ts.map