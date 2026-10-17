// useLobbyCall(lobbyName, opts?) — is there a call in this lobby right now,
// and who is in it, for someone who is NOT in it (0.136.0, lane L9).
//
// A page that shows a huddle card subscribes with the call service's `watch`
// verb: the server runs the host's channel authority on
// `callLobbyChannel(lobbyName)`, subscribes this socket there and answers
// with a `lobby-occupancy` snapshot; after that every seat, leave, dropped
// socket past its grace and call end arrives as another `lobby-occupancy`
// frame. No refresh, no ring.
//
// Outbound: { service: 'call', action: 'watch' | 'unwatch', lobbyName }.
// Inbound:  { type: 'call', action: 'lobby-occupancy', data: CallLobbyOccupancy }.
//
// Socket: like useMeeting, pass `socket` to bypass GatewaySocketProvider;
// with neither the hook is inert. Watches again after every reconnect
// (`sessionEpoch`).

import { useEffect, useRef, useState } from 'react';
import { useGatewayOptional } from '../GatewaySocketProvider';
import type { GatewayMessage } from '../types';
import type { CallLobbyOccupancy } from '../../call/types';

export type { CallLobbyOccupancy } from '../../call/types';

export interface UseLobbyCallOptions {
  /** Set false to hold the subscription. Default true. */
  enabled?: boolean;
  /** Send/receive handles when the caller owns the socket (see useMeeting). */
  socket?: {
    send: (message: Record<string, unknown>) => void;
    onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
    /** Bumps on every new gateway session; the hook watches again. */
    sessionEpoch?: number;
  };
}

export interface UseLobbyCallResult {
  /** A call is live in this lobby. */
  live: boolean;
  callId: string | null;
  /** Distinct people in the call. */
  participantUserIds: string[];
  /** `participantUserIds.length`. */
  count: number;
  /** ISO time the call started, when the server knows it. */
  startedAt: string | null;
}

const IDLE: UseLobbyCallResult = { live: false, callId: null, participantUserIds: [], count: 0, startedAt: null };

/**
 * A `lobby-occupancy` frame's data, checked; null when it is not one. Shared
 * with useConversationCall's discovery.
 */
export function parseLobbyOccupancy(data: unknown): CallLobbyOccupancy | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.lobbyName !== 'string' || !d.lobbyName) return null;
  const active = d.active === true && typeof d.callId === 'string' && d.callId.length > 0;
  const ids = active && Array.isArray(d.participantUserIds)
    ? Array.from(new Set((d.participantUserIds as unknown[]).filter((u): u is string => typeof u === 'string' && u.length > 0)))
    : [];
  const out: CallLobbyOccupancy = {
    lobbyName: d.lobbyName,
    active,
    callId: active ? (d.callId as string) : null,
    participantUserIds: ids,
    participantCount: ids.length,
    startedAt: active && typeof d.startedAt === 'string' ? d.startedAt : null,
  };
  if (active && typeof d.callerId === 'string' && d.callerId) out.callerId = d.callerId;
  if (active && typeof d.callerName === 'string' && d.callerName) out.callerName = d.callerName;
  if (active && d.pageHuddle === true) out.pageHuddle = true;
  return out;
}

function noopSend(): void {}
function inertOnMessage(): () => void {
  return () => {};
}

export function useLobbyCall(lobbyName: string | null | undefined, opts: UseLobbyCallOptions = {}): UseLobbyCallResult {
  const gatewayCtx = useGatewayOptional();
  const sessionEpoch = opts.socket ? opts.socket.sessionEpoch : gatewayCtx?.sessionEpoch;
  const send = opts.socket?.send ?? gatewayCtx?.send ?? noopSend;
  const onMessage = opts.socket?.onMessage ?? gatewayCtx?.onMessage ?? inertOnMessage;
  const enabled = opts.enabled !== false && !!lobbyName;

  const [state, setState] = useState<{ lobby: string | null; value: UseLobbyCallResult }>({ lobby: null, value: IDLE });
  // `send` through a ref: an inline socket hands a new function each render,
  // and keying the watch on it would re-watch forever.
  const sendRef = useRef(send);
  sendRef.current = send;
  const lobbyRef = useRef<string | null>(enabled ? lobbyName! : null);
  lobbyRef.current = enabled ? lobbyName! : null;

  // Inbound first, so the snapshot cannot arrive before anyone listens.
  useEffect(() => {
    return onMessage((msg: GatewayMessage) => {
      const m = msg as unknown as { type?: string; action?: string; data?: unknown };
      if (m.type !== 'call' || m.action !== 'lobby-occupancy') return;
      const occ = parseLobbyOccupancy(m.data);
      if (!occ || occ.lobbyName !== lobbyRef.current) return;
      setState({
        lobby: occ.lobbyName,
        value: { live: occ.active, callId: occ.callId, participantUserIds: occ.participantUserIds, count: occ.participantCount, startedAt: occ.startedAt },
      });
    });
  }, [onMessage]);

  // Watch per lobby, and again after every reconnect.
  useEffect(() => {
    if (!enabled || !lobbyName) return;
    sendRef.current({ service: 'call', action: 'watch', lobbyName });
    return () => {
      sendRef.current({ service: 'call', action: 'unwatch', lobbyName });
    };
  }, [enabled, lobbyName, sessionEpoch]);

  // A frame for another lobby never shows here; neither does a stale one.
  return enabled && state.lobby === lobbyName ? state.value : IDLE;
}
