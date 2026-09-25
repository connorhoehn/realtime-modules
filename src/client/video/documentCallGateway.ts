// The slice of the gateway the document-call hooks use, and how they find
// it: an explicit `gateway` option wins, else the GatewayContext of a
// surrounding GatewaySocketProvider.

import { useContext } from 'react';
import { GatewayContext } from '../GatewaySocketProvider';
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

export function useDocumentCallGateway(explicit?: DocumentCallGateway | null): DocumentCallGateway | null {
  const ctx = useContext(GatewayContext);
  if (explicit) return explicit;
  if (!ctx) return null;
  return ctx as unknown as DocumentCallGateway;
}

export function gatewaySend(gw: DocumentCallGateway | null, msg: Record<string, unknown>): void {
  if (!gw) return;
  const fn = gw.send ?? gw.sendMessage;
  if (typeof fn === 'function') fn(msg);
}

/** A `{ type:'call', action, data }` frame, or null. */
export function asCallFrame(msg: GatewayMessage): { action: string; data: Record<string, unknown> } | null {
  const m = msg as unknown as { type?: string; action?: string; data?: unknown };
  if (m.type !== 'call' || typeof m.action !== 'string') return null;
  const data = m.data && typeof m.data === 'object' ? (m.data as Record<string, unknown>) : {};
  return { action: m.action, data };
}
