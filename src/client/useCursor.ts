// realtime-modules/src/client/useCursor.ts
//
// useCursor(channel, opts?) — the client half of the cursor triple.
//
// CursorService has shipped since the Wave 2 lift with a manifest and a
// service but no hook, and both README and the adoption guide told consumers
// to "consume cursor updates through useAwarenessState" instead. That answer
// only holds if you are already running a Yjs document: awareness rides the
// CRDT provider. A channel that wants Figma-style cursors over the gateway —
// no Y.Doc anywhere — had to hand-roll the frames. This is that hook.
//
// Returns:
//   cursors   — everyone else's live cursor in the channel
//   move      — publish your own position (client-throttled, see below)
//   refresh   — re-ask for the channel snapshot
//
// WIRE CONTRACT (src/cursor/CursorService.ts handleAction):
//   outbound  { service:'cursor', action:'subscribe',   channel }
//             { service:'cursor', action:'unsubscribe', channel }
//             { service:'cursor', action:'update', channel, position, metadata?, mode? }
//             { service:'cursor', action:'get', channel }
//   inbound   { type:'cursor', action:'subscribed', channel, cursors: CursorData[] }
//             { type:'cursor', action:'cursors',    channel, cursors: CursorData[] }
//             { type:'cursor', action:'update',     channel, cursor: CursorData }
//             { type:'cursor', action:'remove',     channel, clientId }
//             { type:'cursor', action:'unsubscribed', channel }
// The cursor verbs have no event-catalog declarations yet, so the send-sites
// carry no `satisfies` annotations — unlike chat/presence/reaction, whose
// frames the contract test pins.
//
// Throttling is the whole reason this hook is not three lines of send().
// The service accepts one update per client per CURSOR_THROTTLE_INTERVAL_MS
// (250 default) and DROPS the rest silently — no error, no ack. A component
// wired straight to onMouseMove fires ~60/s, so roughly 95% of what it sends
// is thrown away after crossing the wire. So `move` throttles locally at the
// same interval, and keeps the last suppressed position to send on the
// trailing edge: without that, the cursor freezes wherever the last accepted
// frame landed rather than where the pointer actually stopped.
//
// Your own updates never come back (broadcastCursorUpdate excludes the
// sender), but the subscribe snapshot is the server's whole channel map and
// can still contain a stale cursor of yours from a previous connection. Pass
// opts.selfClientId to keep it out of `cursors`.
//
// Socket-explicit and provider-optional, like useReactions and
// useChatReadReceipts: pass opts.socket and the hook never reads
// GatewaySocketProvider context. With neither socket nor provider it goes
// inert (empty cursors, no-op move) instead of throwing.

import { useState, useEffect, useRef, useCallback } from 'react';
import { useGatewayOptional } from './GatewaySocketProvider';
import type { CursorEntry, GatewayMessage } from './types';

/** Mirrors CURSOR_THROTTLE_INTERVAL_MS / DEFAULT_THROTTLE_INTERVAL_MS. */
const DEFAULT_THROTTLE_MS = 250;

export interface UseCursorOpts {
  /**
   * Cursor mode — `freeform` | `table` | `text` | `canvas`. Decides which
   * position fields the service requires: freeform/canvas need {x,y}, table
   * needs {row,col}, text needs {position}. Default `freeform`.
   */
  mode?: string;
  /**
   * Metadata merged into every update. `userInitials` and `userColor` are
   * what an overlay labels the cursor with; omit them and the service
   * derives both from the connection id.
   */
  metadata?: Record<string, unknown>;
  /**
   * Your own client id. When given, a cursor carrying it is filtered out of
   * `cursors` — the subscribe snapshot is the server's full channel map and
   * may still hold a stale entry of yours. Default: no filtering.
   */
  selfClientId?: string;
  /**
   * Minimum gap (ms) between updates actually sent. Default 250, matching
   * the service's own throttle. Set this only if the server's
   * CURSOR_THROTTLE_INTERVAL_MS was changed — a smaller value here just
   * means the service drops the extra frames.
   */
  throttleMs?: number;
  /**
   * Send/receive handles when the caller holds the socket itself. Given, the
   * hook never touches GatewaySocketProvider context, so it renders in a
   * subtree with no provider (a canvas inside a call, a component test).
   */
  socket?: {
    send: (message: Record<string, unknown>) => void;
    onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
  };
}

export interface UseCursorReturn {
  /** Live cursors for the channel, excluding your own. */
  cursors: CursorEntry[];
  /**
   * Publish your position. Throttled to opts.throttleMs; a suppressed call
   * is held and sent when the window opens, so the resting position always
   * lands. Per-call metadata is merged over the hook-level metadata.
   */
  move: (position: Record<string, unknown>, metadata?: Record<string, unknown>) => void;
  /** Re-ask the service for the channel's current cursors. */
  refresh: () => void;
}

// Module-scope so their identity never changes across renders — the
// subscribe effect depends on `send`, and a fresh closure each render would
// re-subscribe (and clear state) forever.
function noopSend(): void {}
function inertOnMessage(): () => void {
  return () => {};
}

export function useCursor(channel: string, opts?: UseCursorOpts): UseCursorReturn {
  // Unconditional, non-throwing context read — rules of hooks apply even
  // when opts.socket is given and the context value goes unused.
  const gatewayCtx = useGatewayOptional();
  // undefined when the caller supplied opts.socket — they own that socket's
  // lifecycle, so there is no epoch to follow.
  const sessionEpoch = gatewayCtx?.sessionEpoch;
  const send = opts?.socket?.send ?? gatewayCtx?.send ?? noopSend;
  const onMessage = opts?.socket?.onMessage ?? gatewayCtx?.onMessage ?? inertOnMessage;

  const [cursors, setCursors] = useState<CursorEntry[]>([]);

  const channelRef = useRef(channel);
  useEffect(() => {
    channelRef.current = channel;
  }, [channel]);

  // Latest options read through refs so `move` keeps a stable identity — it
  // is handed to onMouseMove, and a new function every render would rebind
  // the listener on every pointer event.
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  // Inbound frames.
  useEffect(() => {
    const unsubscribe = onMessage((msg: GatewayMessage) => {
      const raw = msg as Record<string, any>;
      if (raw.type !== 'cursor') return;
      if (raw.channel !== channelRef.current) return;

      // The snapshot on subscribe, and the answer to `get`. Both are the
      // channel's whole map, so they REPLACE rather than merge.
      if (raw.action === 'subscribed' || raw.action === 'cursors') {
        const list = Array.isArray(raw.cursors) ? (raw.cursors as unknown[]) : [];
        setCursors(list.map((c) => asCursor(c)).filter(Boolean) as CursorEntry[]);
        return;
      }

      // Somebody moved. Replace their entry in place — one cursor per client.
      if (raw.action === 'update') {
        const entry = asCursor(raw.cursor);
        if (!entry) return;
        setCursors((prev) => {
          const i = prev.findIndex((c) => c.clientId === entry.clientId);
          if (i === -1) return [...prev, entry];
          const next = prev.slice();
          next[i] = entry;
          return next;
        });
        return;
      }

      // Disconnected, or swept for going stale past CURSOR_TTL_MS.
      if (raw.action === 'remove') {
        const gone = typeof raw.clientId === 'string' ? raw.clientId : null;
        if (gone) setCursors((prev) => prev.filter((c) => c.clientId !== gone));
      }
    });
    return unsubscribe;
  }, [onMessage]);

  // Subscribe / unsubscribe. The service only fans out to subscribers, and
  // the subscribe reply carries the snapshot.
  useEffect(() => {
    setCursors([]);
    send({ service: 'cursor', action: 'subscribe', channel });
    return () => {
      send({ service: 'cursor', action: 'unsubscribe', channel });
    };
      // sessionEpoch: a reconnect is a NEW server-side connection that has
    // joined nothing. Keyed only on `send` — a stable callback — this effect
    // would never fire again, and the hook would sit silently unsubscribed
    // while connectionState reads 'connected'.
  }, [channel, send, sessionEpoch]);

  // --- throttle state -------------------------------------------------
  // lastSentAt: when the last frame actually went out.
  // pending: the newest position suppressed since then, waiting on the timer.
  const lastSentAt = useRef(0);
  const pending = useRef<{ position: Record<string, unknown>; metadata?: Record<string, unknown> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A ref so the flush timer and `move` share one sender without either
  // depending on `send`'s identity.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const emit = useCallback((position: Record<string, unknown>, metadata?: Record<string, unknown>) => {
    const o = optsRef.current;
    const frame: Record<string, unknown> = {
      service: 'cursor',
      action: 'update',
      channel: channelRef.current,
      position,
      mode: o?.mode ?? 'freeform',
    };
    const merged = { ...(o?.metadata ?? {}), ...(metadata ?? {}) };
    if (Object.keys(merged).length > 0) frame.metadata = merged;
    lastSentAt.current = Date.now();
    sendRef.current(frame);
  }, []);

  const move = useCallback(
    (position: Record<string, unknown>, metadata?: Record<string, unknown>) => {
      const gap = optsRef.current?.throttleMs ?? DEFAULT_THROTTLE_MS;
      const since = Date.now() - lastSentAt.current;
      if (since >= gap) {
        pending.current = null;
        emit(position, metadata);
        return;
      }
      // Inside the window: hold the newest position and arm one timer for
      // the trailing edge. Without this the cursor would stick at the last
      // accepted frame instead of where the pointer came to rest.
      pending.current = { position, metadata };
      if (timer.current === null) {
        timer.current = setTimeout(() => {
          timer.current = null;
          const held = pending.current;
          pending.current = null;
          if (held) emit(held.position, held.metadata);
        }, gap - since);
      }
    },
    [emit],
  );

  // Drop a queued trailing send on unmount — it would publish a position for
  // a component that is gone, and on a channel it no longer subscribes to.
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      pending.current = null;
    },
    [],
  );

  const refresh = useCallback(() => {
    sendRef.current({ service: 'cursor', action: 'get', channel: channelRef.current });
  }, []);

  const self = opts?.selfClientId;
  const visible = self !== undefined ? cursors.filter((c) => c.clientId !== self) : cursors;

  return { cursors: visible, move, refresh };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asCursor(raw: unknown): CursorEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.clientId !== 'string' || typeof r.channel !== 'string') return null;
  if (!r.position || typeof r.position !== 'object') return null;
  const meta = (typeof r.metadata === 'object' && r.metadata !== null ? r.metadata : {}) as Record<
    string,
    unknown
  >;
  return {
    clientId: r.clientId,
    channel: r.channel,
    position: r.position as Record<string, unknown>,
    metadata: {
      ...meta,
      mode: typeof meta.mode === 'string' ? meta.mode : 'freeform',
      userInitials: typeof meta.userInitials === 'string' ? meta.userInitials : '',
      userColor: typeof meta.userColor === 'string' ? meta.userColor : '',
    },
    timestamp: typeof r.timestamp === 'string' ? r.timestamp : new Date().toISOString(),
  };
}
