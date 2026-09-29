// useIncomingConversationCalls — every DM / room ring addressed to you, for
// the app-wide toast and the DM row badge. One per app. Ported from
// realtime-examples' useIncomingCalls: FIFO queue, de-dup on callId, a TTL
// that ages a ring out silently (as a missed call, never as a decline),
// replayed invites anchored to their original time, and knock admissions
// that join rather than ring.
//
// Document-review invites are not rings here — useIncomingDocumentCalls owns
// those.
//
// `accept(ring)` does not signal the server by itself: joining is the
// conversation's useConversationCall().accept(ring), which sends `accepted`
// once it has a session to join. Wire `onAccept` to open the conversation and
// call that.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GatewayMessage } from '../types';
import { asCallFrame, gatewaySend, useDocumentCallGateway } from './documentCallGateway';
import type {
  ConversationCallDeclineReason,
  ConversationCallGateway,
  IncomingConversationCall,
} from './conversationCallTypes';
import { channelForLobby } from './conversationLobby';

// ---- one page, many hooks ---------------------------------------------------
//
// The app-wide listener and a conversation's own hook both see a ring. When
// one of them answers it, the other must stop showing it; the server tells the
// caller and your OTHER tabs, never this one. So a page-local bus.

type RingSettled = { callId: string; how: 'accepted' | 'declined' };
const settledListeners = new Set<(e: RingSettled) => void>();

/** Internal: a ring was answered in this page. */
export function announceRingSettled(e: RingSettled): void {
  for (const l of Array.from(settledListeners)) {
    try { l(e); } catch { /* a listener never breaks another */ }
  }
}

/** Internal: hear rings answered elsewhere in this page. */
export function onRingSettled(fn: (e: RingSettled) => void): () => void {
  settledListeners.add(fn);
  return () => { settledListeners.delete(fn); };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * An `invite` frame's data as a ring for `selfUserId`, or null when it is not
 * one (your own invite, a document call, an admission, no callId).
 */
export function parseConversationInvite(data: Record<string, unknown>, selfUserId: string | null): IncomingConversationCall | null {
  const callId = str(data.callId);
  const callerId = str(data.callerId);
  if (!callId || !callerId) return null;
  if (data.kind === 'document-review') return null;
  if (data.admit === true) return null;
  if (selfUserId && callerId === selfUserId) return null;
  const targets = new Set<string>();
  if (Array.isArray(data.targetUserIds)) {
    for (const id of data.targetUserIds) if (typeof id === 'string' && id) targets.add(id);
  }
  if (typeof data.targetUserId === 'string' && data.targetUserId) targets.add(data.targetUserId);
  let receivedAt = Date.now();
  // A replayed invite (the server replays live rings on reconnect) keeps its
  // original time, so the TTL reflects how long it has already been ringing.
  if (data.replayed === true && typeof data.originalTimestamp === 'string') {
    const parsed = Date.parse(data.originalTimestamp);
    if (Number.isFinite(parsed)) receivedAt = parsed;
  }
  const lobbyName = str(data.lobbyName) ?? '';
  return {
    callId,
    lobbyName,
    channel: str(data.channel) ?? channelForLobby(lobbyName),
    callerId,
    callerName: str(data.callerName) ?? callerId,
    targeted: !!(selfUserId && targets.has(selfUserId)),
    kind: data.knock === true ? 'knock' : 'invite',
    audioOnly: data.audioOnly === true,
    receivedAt,
  };
}

export interface UseIncomingConversationCallsOptions {
  /** Defaults to the surrounding GatewaySocketProvider. */
  gateway?: ConversationCallGateway | null;
  self: { userId: string | null; displayName?: string };
  /** Ring length. Default 60 s (the server's invite TTL). */
  ttlMs?: number;
  /** A ring aged out unanswered — leave a missed-call trace. */
  onMissed?(ring: IncomingConversationCall): void;
  /** The caller hung up before you answered. */
  onCancelled?(ring: IncomingConversationCall): void;
  /** Accept pressed: open the conversation and call its useConversationCall().accept(ring). */
  onAccept?(ring: IncomingConversationCall): void;
  /** Someone admitted a knock you sent: an `invite` with `admit: true`. Join, don't ring. */
  onAdmitted?(info: { callId: string; lobbyName: string; callerId: string; callerName: string }): void;
}

export interface UseIncomingConversationCallsResult {
  /** Oldest first. The toast shows `rings[0]`. */
  rings: IncomingConversationCall[];
  accept(ring: IncomingConversationCall): void;
  decline(ring: IncomingConversationCall, reason?: ConversationCallDeclineReason): void;
}

export function useIncomingConversationCalls(opts: UseIncomingConversationCallsOptions): UseIncomingConversationCallsResult {
  const gw = useDocumentCallGateway(opts.gateway);
  const gwRef = useRef(gw);
  gwRef.current = gw;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const ttlMs = opts.ttlMs ?? 60_000;

  const [rings, setRings] = useState<IncomingConversationCall[]>([]);
  const ringsRef = useRef(rings);
  ringsRef.current = rings;

  const drop = useCallback((callId: string) => setRings((q) => (q.some((r) => r.callId === callId) ? q.filter((r) => r.callId !== callId) : q)), []);

  const onMessage = gw?.onMessage;
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: GatewayMessage) => {
      const f = asCallFrame(msg);
      if (!f) return;
      const d = f.data;
      const callId = str(d.callId);
      if (!callId) return;
      // Cancelled / ended / answered on another tab of mine — stop ringing.
      if (f.action === 'cancelled' || f.action === 'ended' || f.action === 'accepted') {
        const ring = ringsRef.current.find((r) => r.callId === callId);
        if (!ring) return;
        drop(callId);
        if (f.action === 'cancelled' || (f.action === 'ended' && str(d.reason) === 'no-answer')) optsRef.current.onCancelled?.(ring);
        return;
      }
      if (f.action !== 'invite') return;
      const self = optsRef.current.self.userId;
      if (d.admit === true) {
        const callerId = str(d.callerId);
        if (!callerId || callerId === self) return;
        optsRef.current.onAdmitted?.({ callId, lobbyName: str(d.lobbyName) ?? '', callerId, callerName: str(d.callerName) ?? callerId });
        return;
      }
      const ring = parseConversationInvite(d, self);
      if (!ring) return;
      setRings((q) => (q.some((r) => r.callId === ring.callId) ? q : [...q, ring]));
    });
  }, [onMessage, drop]);

  useEffect(() => onRingSettled(({ callId }) => drop(callId)), [drop]);

  // TTL: the head of the queue ages out silently — never a decline.
  const head = rings[0] ?? null;
  useEffect(() => {
    if (!head) return;
    const remaining = head.receivedAt + ttlMs - Date.now();
    const t = setTimeout(() => {
      drop(head.callId);
      optsRef.current.onMissed?.(head);
    }, Math.max(0, remaining));
    return () => clearTimeout(t);
  }, [head, ttlMs, drop]);

  const accept = useCallback((ring: IncomingConversationCall) => {
    drop(ring.callId);
    optsRef.current.onAccept?.(ring);
  }, [drop]);

  const decline = useCallback((ring: IncomingConversationCall, reason?: ConversationCallDeclineReason) => {
    drop(ring.callId);
    announceRingSettled({ callId: ring.callId, how: 'declined' });
    // Only a targeted ring has someone waiting on an answer.
    if (!ring.targeted) return;
    gatewaySend(gwRef.current, {
      service: 'call',
      action: 'declined',
      callId: ring.callId,
      targetUserIds: [ring.callerId],
      callerId: optsRef.current.self.userId,
      lobbyName: ring.lobbyName,
      ...(reason ? { reason } : {}),
    });
  }, [drop]);

  return { rings, accept, decline };
}
