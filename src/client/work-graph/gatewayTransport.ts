import type { WorkGraphClientTransport, WorkGraphSocket, WorkGraphSocketRequest } from './useWorkGraph';

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
export function createWorkGraphGatewayTransport(options: WorkGraphGatewayTransportOptions): WorkGraphClientTransport {
  const service = options.service ?? 'work-graph';
  return {
    fetchSnapshot: (request) => options.fetchSnapshot(request),
    openWebSocket(request: WorkGraphSocketRequest): WorkGraphSocket {
      if (options.isConnected && !options.isConnected()) throw new Error('work-graph stream: socket not connected');
      const generation = request.subscriptionGeneration;
      let open = true;
      let stop: (() => void) | null = null;
      const finish = (terminal: () => void) => {
        if (!open) return;
        open = false;
        stop?.();
        stop = null;
        terminal();
      };
      stop = options.gateway.onMessage((frame: any) => {
        if (!open || !frame || typeof frame !== 'object') return;
        // A new session is a new connection: the server forgot this stream.
        if (frame.type === 'session') { finish(() => request.onClose()); return; }
        if (frame.subscriptionGeneration !== generation) return;
        if (frame.type === 'error' && frame.service === service) { finish(() => request.onError()); return; }
        if (frame.type !== service) return;
        if (frame.action === 'message') request.onMessage(frame.message);
      });
      options.gateway.send({
        service,
        action: 'subscribe',
        subscriptionGeneration: generation,
        scope: { personId: request.scope.personId, day: request.scope.day, timezone: request.scope.timezone },
        ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
        ...(request.awaitAccess ? { awaitAccess: 1 } : {}),
        ...(request.activity ? { activity: request.activity } : {}),
        ...(request.viewPatch ? { viewPatch: 1 } : {}),
        ...(request.baseViewHash ? { baseViewHash: request.baseViewHash } : {}),
      });
      return {
        close() {
          if (!open) return;
          open = false;
          stop?.();
          stop = null;
          try { options.gateway.send({ service, action: 'unsubscribe', subscriptionGeneration: generation }); } catch { /* socket gone */ }
        },
      };
    },
  };
}
