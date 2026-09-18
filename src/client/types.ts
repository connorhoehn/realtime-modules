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
  /**
   * Which service refused, when the frame said so.
   *
   * `lastError` is a single slot shared by every service on the socket, so
   * without this a chat refusal and a cursor refusal are indistinguishable
   * after the fact. event-catalog's `ws.error` carries `service` in both of
   * its shapes; optional because handler-level errors and older servers may
   * omit it.
   */
  service?: string;
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
  /**
   * Increments each time a gateway session is established — once on the first
   * connect, and again on every reconnect.
   *
   * Channel membership does not survive a reconnect: the server has a new
   * connection and knows nothing of what the old one had joined. useWebSocket
   * says as much where it auto-resubscribes — "the gateway's pull model leaves
   * subscribe lifecycle to feature hooks" — but `send` is a stable callback,
   * so an effect keyed on `[channel, send]` never fires again and the hook
   * stays silently unsubscribed while `connectionState` reads 'connected'.
   *
   * Feature hooks include this in those deps. A consumer wiring frames by hand
   * should do the same for anything that must be re-sent on a new session.
   *
   * Optional because an app may bridge its OWN socket onto GatewayContext
   * rather than mount the provider — a case ./client documents — and those
   * contexts are built by hand. Requiring this would break every one of them
   * at compile time to add a field they cannot meaningfully supply. Undefined
   * simply means "no session signal here", and the hooks then behave as they
   * did: subscribe once, and leave the socket's lifecycle to whoever owns it.
   */
  sessionEpoch?: number;
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
//
// CONTRACT GUARD (Wave A3): the canonical declarations for these shapes
// live in @connorhoehn/event-catalog's `client-frames` subpath. These local
// definitions stay the public API (deliberately NOT aliased so the built
// dist carries zero event-catalog references), and drift between the two is
// caught at compile time by test/contract/contract-conformance.test.ts
// (`npm run check:contract`, also type-checked on every `npm test`).
// ---------------------------------------------------------------------------

/** A persisted chat message — mirror of gateway/chat/types.ts ChatMessage. */
export interface ChatMessage {
  id: string;
  clientId: string;
  /**
   * Authenticated user id of the sender (auth subject, stable across
   * reconnects) — distinct from the per-connection `clientId`. Present
   * only when the server's ChatService runs an identityResolver.
   */
  userId?: string;
  channel: string;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  /** ISO: the author changed the text after sending. */
  editedAt?: string;
  /** ISO: the author took it back; text is empty and metadata is {deleted:true}. */
  deletedAt?: string;
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
  /** Optional entity being reacted to (messageId, articleId, commentId, …). */
  targetId?: string;
  /**
   * Stable owner id, stamped server-side from the connection's authenticated
   * context (never from the frame). Absent when the server resolved no
   * identity. This — not `clientId` — is what makes "you already reacted"
   * answerable across a reload, so grouping and toggling both key on it.
   */
  userId?: string;
  /** Owner's display name, stamped alongside `userId`. */
  displayName?: string;
}

/** One activity event — mirror of gateway/activity/types.ts ActivityEvent. */
export interface ActivityEvent {
  eventType: string;
  detail: Record<string, unknown>;
  timestamp: string;
  userId: string | null;
  displayName: string;
}

/**
 * One live cursor — post-parse mirror of cursor/types.ts CursorData, which is
 * what CursorService stores and broadcasts. `position` is mode-dependent:
 * `{x,y}` for freeform/canvas, `{row,col}` for table, `{position}` for text.
 * The service stamps `mode`, `userInitials` and `userColor` into metadata on
 * every update, so an overlay can render a labelled cursor with no extra
 * lookup.
 */
export interface CursorEntry {
  clientId: string;
  channel: string;
  position: Record<string, unknown>;
  metadata: Record<string, unknown> & {
    mode: string;
    userInitials: string;
    userColor: string;
  };
  /** ISO-8601 — when the sender generated this position. */
  timestamp: string;
}
