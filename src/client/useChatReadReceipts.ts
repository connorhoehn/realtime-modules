// realtime-modules/src/client/useChatReadReceipts.ts
//
// useChatReadReceipts(channel, opts?) — who has read how far in a chat
// channel, and the one call that says the viewer has read up to a point.
//
// A sibling of useChat rather than more return fields on it, for three
// reasons. (1) The socket dependency: useChat reads
// GatewaySocketProvider context and THROWS without it, and the lesson this
// codebase already wrote down — see the consuming app's
// `frontend/src/hooks/useCallReactions.ts` header, and `useReactions`'
// `opts.socket` that followed it — is that a hidden context dependency is
// the wrong default. This hook takes the socket in its signature, so it
// renders in a subtree with no provider and unit-tests without one.
// (2) The inputs are different: a receipt depends on whether the panel is
// being LOOKED at, which the transcript does not care about. (3) A
// conversation rail wants "who has read my last message" without mounting
// a transcript at all.
//
// ---------------------------------------------------------------------
// WHEN TO SEND A RECEIPT — the rule, so no host has to guess
// ---------------------------------------------------------------------
// A read receipt must mean "a person looked at this", not "a browser tab
// received this". The hook sends `read` when ALL of these hold:
//
//   1. the document is VISIBLE (`document.visibilityState === 'visible'`)
//      — a background tab has received the messages and read none of them;
//   2. the panel is ACTIVE — the window has focus and the chat is the thing
//      on screen (not a minimised popout, not a hidden tab in the app's own
//      tab strip). The host owns this fact and passes it as `opts.active`,
//      because only the host knows its own layout;
//   3. the NEWEST message is actually rendered — `opts.newestMessage` is
//      what the transcript has scrolled to the bottom of. Scrolled up
//      through history, the cursor stays where it was: the server refuses
//      to move it backwards anyway, so passing an older message is safe but
//      pointless.
//
// The hook applies (1) itself and folds it into `opts.active`, so a host
// that passes `active={panelFocused}` gets the visibility rule for free.
// It also de-duplicates (never re-sends a cursor at or behind the last one
// sent) and coalesces bursts to at most one frame per `throttleMs`, so a
// fast-arriving thread costs one frame a second, not one per message.
//
// Call `markRead()` by hand for the cases the rule cannot see: the user
// clicking into the composer, an "jump to latest" button, a panel that
// became active without any new message arriving.
//
// ---------------------------------------------------------------------
// WIRE CONTRACT (gateway ChatService — realtime-modules/src/chat)
// ---------------------------------------------------------------------
//   outbound { service:'chat', action:'read',     channel, messageId?, at? }
//   outbound { service:'chat', action:'receipts', channel }
//   inbound  { type:'chat', action:'receipts', channel, enabled, reason?,
//              limit, receipts: [{ userId, displayName?, readAt, updatedAt }] }
//              — full state: the reply to `receipts`, and re-broadcast to
//                the channel whenever the roster changes. REPLACES.
//   inbound  { type:'chat', action:'readReceipt', channel, userId,
//              displayName?, readAt, updatedAt } — one cursor moved. MERGES.
//
// `enabled:false` means this channel does not keep receipts —
// `reason: 'open-channel' | 'too-many-members' | 'unknown-roster' |
// 'disabled'`. The hook then stops sending `read` entirely, so a large
// channel costs nothing. Surface the reason rather than an empty list: "no
// receipts here" and "nobody has read it" look identical otherwise.
//
// The server stores a CURSOR per person (`readAt` = the timestamp of the
// newest message they have seen), so "has X read message M" is
// `readAt >= M.timestamp` — which is what `readersOf` does. There is no
// per-message receipt to ask for, by design; see ChatReadReceiptStore.
//
// No `satisfies ClientFramePayload<...>` on the send-sites: `client.chat.read`
// and `client.chat.receipts` are not declared in @connorhoehn/event-catalog
// yet (the same state `leave` and the reaction subscribe verbs are in, and
// annotated the same way — the declarations land with the next EC cut).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGatewayOptional } from './GatewaySocketProvider';
import type { GatewayMessage } from './types';

/** One person's read cursor, as the wire carries it. */
export interface ChatReadReceiptEntry {
  userId: string;
  displayName?: string;
  /** ISO-8601 — the timestamp of the newest message they have seen. */
  readAt: string;
  /** ISO-8601 — when their cursor last moved ("seen 09:07"). */
  updatedAt: string;
}

/** Why a channel keeps no receipts. */
export type ChatReceiptsDisabledReason =
  | 'disabled'
  | 'open-channel'
  | 'unknown-roster'
  | 'too-many-members';

/** Anything the hook can take a read position from. */
export type ReadPosition = string | { id?: string; timestamp: string };

export interface UseChatReadReceiptsOpts {
  /**
   * Send/receive handles, when the caller holds the socket itself. Given,
   * the hook never touches GatewaySocketProvider context — which is what
   * lets it render in a subtree with no provider. Omit it and the hook
   * reads context; omit BOTH and it goes inert (no receipts, no-op
   * markRead) rather than throwing.
   */
  socket?: {
    send: (message: Record<string, unknown>) => void;
    onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
  };
  /**
   * The viewer. Their own cursor is dropped from `receipts` and from every
   * `readersOf` answer — "seen by you" is not information.
   */
  currentUserId?: string;
  /**
   * Is the panel genuinely being looked at: the window focused and this
   * chat the thing on screen. Combined with document visibility, this is
   * what gates the automatic send (rule 2 above). Default false — a host
   * that passes nothing sends nothing automatically and drives the hook
   * with `markRead()`.
   */
  active?: boolean;
  /**
   * The newest message the transcript currently shows. When it changes
   * while `active`, that is the read (rule 3 above). Pass `null` while the
   * transcript is empty or the user has scrolled away from the bottom.
   */
  newestMessage?: ReadPosition | null;
  /** Floor between automatic sends. Default 1000ms. */
  throttleMs?: number;
}

export interface UseChatReadReceiptsReturn {
  /** Everyone else's cursors, newest reader first. Empty when disabled. */
  receipts: ChatReadReceiptEntry[];
  /** Does this channel keep receipts at all? */
  enabled: boolean;
  /** Why not, when it does not. */
  reason: ChatReceiptsDisabledReason | null;
  /** Largest channel the server keeps receipts for — for the "off in big channels" copy. */
  limit: number | null;
  /** True until the first `receipts` frame for this channel arrives. */
  loading: boolean;
  /**
   * Say the viewer has read up to here. Takes a message, an ISO string, or
   * nothing (meaning now). Safe to call as often as you like: it never
   * sends a position at or behind the last one sent, and the server refuses
   * to move a cursor backwards regardless.
   */
  markRead: (upTo?: ReadPosition) => void;
  /** Who has read `message` — everyone whose cursor is at or past its timestamp. */
  readersOf: (message: ReadPosition) => ChatReadReceiptEntry[];
  /** `readersOf(message).length`, without building the array. */
  readCountOf: (message: ReadPosition) => number;
  /** Re-request the full roster of cursors. */
  refresh: () => void;
}

const DEFAULT_THROTTLE_MS = 1_000;

// Stable module-scope fallbacks for the "no socket, no provider" case, so
// the hook's effects do not re-fire on every render.
function noopSend(): void {}
function inertOnMessage(): () => void {
  return () => {};
}

export function useChatReadReceipts(
  channel: string,
  opts?: UseChatReadReceiptsOpts,
): UseChatReadReceiptsReturn {
  // Unconditional, non-throwing context read — rules of hooks, even when
  // opts.socket is given and the context value ends up unused.
  const gatewayCtx = useGatewayOptional();
  // undefined when the caller supplied opts.socket — they own that socket's
  // lifecycle, so there is no epoch to follow.
  const sessionEpoch = gatewayCtx?.sessionEpoch;
  const send = opts?.socket?.send ?? gatewayCtx?.send ?? noopSend;
  const onMessage = opts?.socket?.onMessage ?? gatewayCtx?.onMessage ?? inertOnMessage;

  const [all, setAll] = useState<ChatReadReceiptEntry[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [reason, setReason] = useState<ChatReceiptsDisabledReason | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const channelRef = useRef(channel);
  useEffect(() => { channelRef.current = channel; }, [channel]);

  // What this connection last told the server it had read. The de-dupe that
  // keeps a fast thread from costing one frame per message.
  const sentRef = useRef<string>('');
  const lastSendAtRef = useRef(0);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef(false);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const refresh = useCallback(() => {
    if (!channelRef.current) return;
    send({ service: 'chat', action: 'receipts', channel: channelRef.current });
  }, [send]);

  useEffect(() => {
    const unsubscribe = onMessage((msg: GatewayMessage) => {
      if (msg.type !== 'chat' || msg.channel !== channelRef.current) return;
      const raw = msg as Record<string, unknown>;

      if (msg.action === 'receipts') {
        // Full state — replace.
        const list = Array.isArray(raw.receipts) ? (raw.receipts as unknown[]) : [];
        setAll(list.map(asReceipt).filter(Boolean) as ChatReadReceiptEntry[]);
        setEnabled(raw.enabled === true);
        setReason(raw.enabled === true ? null : asReason(raw.reason));
        setLimit(typeof raw.limit === 'number' ? raw.limit : null);
        setLoading(false);
        return;
      }

      if (msg.action === 'readReceipt') {
        // One cursor moved — merge. The server only broadcasts a cursor that
        // actually advanced, so last-write-wins is correct here.
        const entry = asReceipt(raw);
        if (!entry) return;
        setAll((prev) => {
          const without = prev.filter((r) => r.userId !== entry.userId);
          return [entry, ...without].sort((a, b) => (a.readAt < b.readAt ? 1 : a.readAt > b.readAt ? -1 : 0));
        });
        // Our own echo carries the value the server ACCEPTED (clamped to
        // now, never backwards). Trust it over what we believed we sent.
        if (opts?.currentUserId && entry.userId === opts.currentUserId) {
          if (!sentRef.current || isBefore(sentRef.current, entry.readAt)) sentRef.current = entry.readAt;
        }
        return;
      }

      if (msg.action === 'removed') {
        // This connection was removed from the channel: it may not see who
        // is reading it any more.
        setAll([]);
        setEnabled(false);
        return;
      }
    });
    return unsubscribe;
  }, [onMessage, opts?.currentUserId]);

  // Ask for the roster on mount / channel change. Deliberately NOT pushed
  // by the server on join: a client that does not render receipts should
  // not pay a frame for them.
  useEffect(() => {
    setAll([]);
    setEnabled(false);
    setReason(null);
    setLimit(null);
    setLoading(true);
    sentRef.current = '';
    lastSendAtRef.current = 0;
    refresh();
    return () => {
      if (pendingRef.current) { clearTimeout(pendingRef.current); pendingRef.current = null; }
    };
    // sessionEpoch: the reply to this only ever arrives once, on request —
    // nothing is pushed on join. Without it a reconnect leaves whatever the
    // panel held before the drop standing for the rest of the session, so a
    // membership change or a read that happened while offline is never seen.
  }, [channel, refresh, sessionEpoch]);

  const sendRead = useCallback((position: ReadPosition | undefined) => {
    const channelNow = channelRef.current;
    if (!channelNow || !enabledRef.current) return;
    const at = timestampOf(position) ?? new Date().toISOString();
    // Never walk the cursor backwards, and never repeat it.
    if (sentRef.current && !isBefore(sentRef.current, at)) return;

    const fire = () => {
      pendingRef.current = null;
      lastSendAtRef.current = Date.now();
      sentRef.current = at;
      const id = typeof position === 'object' && position && position.id ? position.id : undefined;
      send({
        service: 'chat',
        action: 'read',
        channel: channelNow,
        ...(id ? { messageId: id } : {}),
        at,
      });
    };

    const throttleMs = opts?.throttleMs ?? DEFAULT_THROTTLE_MS;
    const since = Date.now() - lastSendAtRef.current;
    if (since >= throttleMs) { fire(); return; }
    // Trailing edge: the last position in a burst is the one that matters.
    if (pendingRef.current) clearTimeout(pendingRef.current);
    pendingRef.current = setTimeout(fire, throttleMs - since);
  }, [send, opts?.throttleMs]);

  const markRead = useCallback((upTo?: ReadPosition) => { sendRead(upTo); }, [sendRead]);

  // The automatic path: active panel + a visible document + a newest
  // message on screen. Re-runs when any of the three changes.
  const newestTimestamp = timestampOf(opts?.newestMessage ?? undefined);
  const newestId = typeof opts?.newestMessage === 'object' && opts?.newestMessage ? opts.newestMessage.id : undefined;
  useEffect(() => {
    if (!enabled || !opts?.active || !newestTimestamp) return;
    if (!documentIsVisible()) return;
    sendRead(newestId ? { id: newestId, timestamp: newestTimestamp } : newestTimestamp);
  }, [enabled, opts?.active, newestTimestamp, newestId, sendRead]);

  // A tab brought back to the front is a read, and no message needs to have
  // arrived for it to be one.
  useEffect(() => {
    if (typeof document === 'undefined' || !opts?.active || !newestTimestamp) return;
    const onVisible = () => {
      if (documentIsVisible()) {
        sendRead(newestId ? { id: newestId, timestamp: newestTimestamp } : newestTimestamp);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [opts?.active, newestTimestamp, newestId, sendRead]);

  const receipts = useMemo(
    () => (opts?.currentUserId ? all.filter((r) => r.userId !== opts.currentUserId) : all),
    [all, opts?.currentUserId],
  );

  const readersOf = useCallback(
    (message: ReadPosition): ChatReadReceiptEntry[] => {
      const at = timestampOf(message);
      if (!at) return [];
      return receipts.filter((r) => !isBefore(r.readAt, at));
    },
    [receipts],
  );

  const readCountOf = useCallback(
    (message: ReadPosition): number => readersOf(message).length,
    [readersOf],
  );

  return { receipts, enabled, reason, limit, loading, markRead, readersOf, readCountOf, refresh };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function documentIsVisible(): boolean {
  // Non-browser (SSR, jsdom without the property): assume visible rather
  // than silently never sending.
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

function timestampOf(position: ReadPosition | undefined): string | undefined {
  if (typeof position === 'string') return position || undefined;
  if (position && typeof position === 'object' && typeof position.timestamp === 'string') return position.timestamp;
  return undefined;
}

/** ISO-8601 compare that tolerates a value that will not parse. */
function isBefore(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x < y;
  return a < b;
}

function asReceipt(raw: unknown): ChatReadReceiptEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.userId !== 'string' || !r.userId) return null;
  if (typeof r.readAt !== 'string' || !r.readAt) return null;
  return {
    userId: r.userId,
    ...(typeof r.displayName === 'string' && r.displayName ? { displayName: r.displayName } : {}),
    readAt: r.readAt,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : r.readAt,
  };
}

function asReason(raw: unknown): ChatReceiptsDisabledReason | null {
  return raw === 'disabled' || raw === 'open-channel' || raw === 'unknown-roster' || raw === 'too-many-members'
    ? raw
    : null;
}
