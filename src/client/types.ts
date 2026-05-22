// realtime-modules/src/client/types.ts
//
// Minimal contract types the client hooks (useCRDT / useYjsDoc) consume.
// These mirror the subset of gateway types the originals depend on
// (frontend/src/types/gateway.ts and frontend/src/hooks/useWebSocket.ts).
// Consumers passing their own WebSocket wiring should satisfy these shapes.

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

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

// ---------------------------------------------------------------------------
// Realtime-feature wire-shape types (mirrors of gateway's
// src/realtime-fanout/{chat,presence,reactions,activity}/types.ts).
//
// Copied (not imported) so this package stays decoupled from the gateway
// source tree. The four feature hooks below (useChat, usePresence,
// useReactions, useActivity) consume these shapes verbatim from the
// gateway's outbound WS frames.
// ---------------------------------------------------------------------------

/** A persisted chat message — mirror of gateway/chat/types.ts ChatMessage. */
export interface ChatMessage {
  id: string;
  clientId: string;
  channel: string;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/** Presence status values accepted by the gateway's presence service. */
export type PresenceStatus = 'online' | 'away' | 'busy' | 'offline';

/**
 * One presence entry — mirror of gateway/presence/types.ts PresenceEntry.
 * Field set is preserved verbatim so the WS wire surface stays byte-identical.
 */
export interface PresenceEntry {
  clientId: string;
  status: PresenceStatus;
  metadata: Record<string, unknown>;
  channels: string[];
  nodeId: string;
  timestamp: string;
  lastSeen: string;
  lastHeartbeat: number;
}

/** One reaction event — mirror of gateway/reactions/types.ts Reaction. */
export interface Reaction {
  id: string;
  clientId: string;
  channel: string;
  emoji: string;
  effect: string;
  position: unknown;
  metadata: Record<string, unknown>;
  timestamp: string;
}

/** One activity event — mirror of gateway/activity/types.ts ActivityEvent. */
export interface ActivityEvent {
  eventType: string;
  detail: Record<string, unknown>;
  timestamp: string;
  userId: string | null;
  displayName: string;
}
