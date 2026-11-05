// realtime-modules/src/client/SharedSocketProvider.tsx
//
// Puts one shared socket transport (createSharedSocketTransport) in context
// (0.145.0), so useLiveRefresh and an app's pages reach it without prop
// drilling — and without nulling it while the socket is down. The transport
// is stable for the provider's life; whether frames can arrive right now is
// `connectionState` / `live`, read beside it.
//
// Three ways to feed it:
//
//   // 1. It owns the socket (useSharedWebSocket inside).
//   <SharedSocketProvider options={{ url, authToken, maxRetries: 5 }}>
//
//   // 2. The host already owns one (useSharedWebSocket in the app shell).
//   const { socket, transport } = useSharedWebSocket({ url, onMessage });
//   <SharedSocketProvider socket={socket} transport={transport}>
//
//   // 3. Bridge the nearest GatewaySocketProvider's socket.
//   <GatewaySocketProvider url={url}><SharedSocketProvider fromGateway>…
//
// Precedence. This context and GatewaySocketProvider's are separate.
// useLiveRefresh reads its `socket` option first, then the nearest
// SharedSocketProvider, and never GatewaySocketProvider directly — inside a
// gateway provider, mount `<SharedSocketProvider fromGateway>` to use its
// socket. The feature hooks (useChat, usePipelineRunStatus without a
// `transport`, …) keep reading GatewaySocketProvider and are unaffected by
// this provider. The bridge's channel holds are refcounted among the shared
// transport's consumers only; the gateway's own feature hooks send their
// subscribes directly, so do not hold the same channel both ways.

import React, { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { ConnectionState } from './types';
import type { UseWebSocketOptions } from './useWebSocket';
import type { SharedSocketTransport } from './sharedSocketTransport';
import { useSharedSocketTransport, useSharedWebSocket } from './useSharedSocketTransport';
import type { UseSharedSocketTransportOptions } from './useSharedSocketTransport';
import { useGateway } from './GatewaySocketProvider';

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

const SharedSocketContext = createContext<SharedSocketContextValue | null>(null);

/** The nearest SharedSocketProvider's value, or null outside one. */
export function useSharedSocket(): SharedSocketContextValue | null {
  return useContext(SharedSocketContext);
}

/** What a host-owned socket gives the provider: `useWebSocket()`'s return satisfies it. */
export interface SharedSocketStatus {
  connectionState?: ConnectionState;
  sessionEpoch?: number;
}

export type SharedSocketProviderProps = { children?: ReactNode } & (
  | {
      /** Own the socket: `useSharedWebSocket(options, transportOptions)`. `options.onMessage` sees every frame first. */
      options: UseWebSocketOptions;
      transportOptions?: UseSharedSocketTransportOptions;
      socket?: never; transport?: never; fromGateway?: never;
    }
  | {
      /** A host-owned socket's state (`useSharedWebSocket().socket`). */
      socket: SharedSocketStatus;
      /** Its transport (`useSharedWebSocket().transport`). */
      transport: SharedSocketTransport;
      options?: never; transportOptions?: never; fromGateway?: never;
    }
  | {
      /** Bridge the nearest GatewaySocketProvider's socket. */
      fromGateway: true;
      transportOptions?: UseSharedSocketTransportOptions;
      options?: never; socket?: never; transport?: never;
    }
);

function useValue(transport: SharedSocketTransport, socket: SharedSocketStatus): SharedSocketContextValue {
  const connectionState: ConnectionState = socket.connectionState ?? 'connected';
  const sessionEpoch = socket.sessionEpoch;
  return useMemo(() => ({
    transport,
    connectionState,
    live: connectionState === 'connected',
    ...(sessionEpoch !== undefined ? { sessionEpoch } : {}),
  }), [transport, connectionState, sessionEpoch]);
}

function Owned({ options, transportOptions, children }: { options: UseWebSocketOptions; transportOptions?: UseSharedSocketTransportOptions; children?: ReactNode }) {
  const { socket, transport } = useSharedWebSocket(options, transportOptions);
  const value = useValue(transport, socket);
  return <SharedSocketContext.Provider value={value}>{children}</SharedSocketContext.Provider>;
}

function Bound({ socket, transport, children }: { socket: SharedSocketStatus; transport: SharedSocketTransport; children?: ReactNode }) {
  const value = useValue(transport, socket);
  return <SharedSocketContext.Provider value={value}>{children}</SharedSocketContext.Provider>;
}

function FromGateway({ transportOptions, children }: { transportOptions?: UseSharedSocketTransportOptions; children?: ReactNode }) {
  const gateway = useGateway();
  const transport = useSharedSocketTransport(gateway, transportOptions);
  const { onMessage } = gateway;
  useEffect(() => onMessage((frame) => transport.deliver(frame)), [onMessage, transport]);
  const value = useValue(transport, gateway);
  return <SharedSocketContext.Provider value={value}>{children}</SharedSocketContext.Provider>;
}

/** One shared socket transport in context; see the file header for the three modes and the precedence. */
export function SharedSocketProvider(props: SharedSocketProviderProps): React.ReactElement {
  if (props.fromGateway) return <FromGateway transportOptions={props.transportOptions}>{props.children}</FromGateway>;
  if (props.transport) return <Bound socket={props.socket} transport={props.transport}>{props.children}</Bound>;
  return <Owned options={props.options!} transportOptions={props.transportOptions}>{props.children}</Owned>;
}
