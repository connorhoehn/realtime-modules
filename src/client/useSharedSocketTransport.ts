// realtime-modules/src/client/useSharedSocketTransport.ts
//
// React binding for createSharedSocketTransport (v0.144.0).
//
//   // The host owns the socket; useSharedWebSocket wraps useWebSocket and
//   // fans its single onMessage out to everyone.
//   const { socket, transport } = useSharedWebSocket({ url, authToken });
//   const runTransport = transport.asPipelineRunTransport();
//   usePipelineRunStatus(runs, { apiBaseUrl, idToken, transport: runTransport,
//     sessionEpoch: socket.sessionEpoch });
//   <EventStreamProvider channelTransport={transport.asChannelTransport()}>
//
// Or bind a socket built elsewhere with `useSharedSocketTransport(socket)` and
// hand each inbound frame to `transport.deliver`.
//
// The binding runs in a layout effect, before the consumers' passive effects
// in the same commit, so a new epoch re-sends every held channel once and the
// consumers' own release-and-re-hold on that epoch sends nothing more.

import { useEffect, useLayoutEffect, useState } from 'react';
import { useWebSocket } from './useWebSocket';
import type { UseWebSocketHookReturn, UseWebSocketOptions } from './useWebSocket';
import type { GatewayMessage } from './types';
import { createSharedSocketTransport } from './sharedSocketTransport';
import type { SharedSocketTransport, SharedSocketTransportOptions } from './sharedSocketTransport';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

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
export function useSharedSocketTransport(
  socket: SharedSocketBinding | null | undefined,
  options?: UseSharedSocketTransportOptions,
): SharedSocketTransport {
  const [transport] = useState(() => createSharedSocketTransport({
    ...(options?.scheduleRelease ? { scheduleRelease: options.scheduleRelease } : {}),
    ...(options?.onHandlerError ? { onHandlerError: options.onHandlerError } : {}),
  }));
  const send = socket?.send;
  const epoch = socket ? socket.sessionEpoch : 0;
  const state = socket?.connectionState;
  useIsomorphicLayoutEffect(() => {
    transport.update({
      send,
      sessionEpoch: epoch,
      isOpen: state === undefined ? undefined : () => state === 'connected',
    });
  }, [transport, send, epoch, state]);
  return transport;
}

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
export function useSharedWebSocket(
  options: UseWebSocketOptions,
  transportOptions?: UseSharedSocketTransportOptions,
): UseSharedWebSocketResult {
  const [holder] = useState<{ deliver?: (frame: unknown) => void }>(() => ({}));
  const hostOnMessage = options.onMessage;
  const socket = useWebSocket({
    ...options,
    onMessage: (msg: GatewayMessage) => {
      hostOnMessage?.(msg);
      holder.deliver?.(msg);
    },
  });
  const transport = useSharedSocketTransport(socket, transportOptions);
  holder.deliver = transport.deliver;
  return { socket, transport };
}
