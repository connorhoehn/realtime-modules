// useIncomingDocumentCalls — rings for document calls (`kind:'document-review'`
// invites), queued FIFO with the same TTL and de-dup rules as the app's
// useIncomingCalls. Other invites (DM, room) are ignored here and keep their
// own toast. SPEC §2.5 / §5.3.
//
// `accept` does not signal the server by itself: joining is
// useDocumentCall.join(), which sends `accepted` once the media session is
// minted. Wire `onAccept` to it (or call join with the returned invite).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GatewayMessage } from '../types';
import {
  asCallFrame,
  gatewaySend,
  useDocumentCallGateway,
  type DocumentCallGateway,
} from './documentCallGateway';

export interface IncomingDocumentCallPerson {
  userId: string;
  displayName: string;
  avatarUrl?: string;
}

export interface IncomingDocumentCall {
  callId: string;
  callerId: string;
  callerName: string;
  callerAvatarUrl?: string;
  lobbyName: string;
  /** The invite named this user (not an ambient broadcast). */
  targeted: boolean;
  kind: 'document-review';
  /** Host document. */
  documentId: string;
  title: string;
  documentIds: string[];
  documentTitles?: Record<string, string>;
  message?: string;
  /** People in the call when the invite was sent (for "3 in call"). */
  participantCount: number;
  /** Who is in it, when the caller sent names (avatar stack). */
  participants?: IncomingDocumentCallPerson[];
  media: 'video' | 'audio';
  receivedAt: number;
  expiresAt: number;
}

export interface UseIncomingDocumentCallsOptions {
  gateway?: DocumentCallGateway | null;
  localUserId: string | null;
  /** Ring length. Default 60 s (the server's per-target TTL). */
  ttlMs?: number;
  /** The ring aged out unanswered — leave a missed-call trace. */
  onMissed?(invite: IncomingDocumentCall): void;
  /** Join button: typically `(inv, media) => documentCall.join(inv.callId, media)`. */
  onAccept?(invite: IncomingDocumentCall, media: { micOn: boolean; cameraOn: boolean }): void;
}

export interface UseIncomingDocumentCallsResult {
  current: IncomingDocumentCall | null;
  /** Everything ringing, oldest first (current is [0]). */
  queue: IncomingDocumentCall[];
  queueLength: number;
  /** Take the current ring: pops it and calls onAccept. Returns it. */
  accept(media: { micOn: boolean; cameraOn: boolean }): IncomingDocumentCall | null;
  /** Say no (`declined` with a reason goes to the caller) and pop. */
  decline(reason: 'not-now' | 'busy'): void;
  /** Pop without telling anyone (the ring stays unanswered → missed). */
  dismiss(): void;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Parse an invite frame into an IncomingDocumentCall, or null when it is not
 *  a document-call ring for this user. Exported for tests and custom queues. */
export function parseDocumentInvite(data: Record<string, unknown>, localUserId: string | null, ttlMs: number, now = Date.now()): IncomingDocumentCall | null {
  if (data.kind !== 'document-review') return null;
  const callId = str(data.callId);
  const callerId = str(data.callerId);
  if (!callId || !callerId) return null;
  if (localUserId && callerId === localUserId) return null; // my own other tabs
  const targets = Array.isArray(data.targetUserIds) ? (data.targetUserIds as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  let receivedAt = now;
  if (data.replayed === true && typeof data.originalTimestamp === 'string') {
    const t = Date.parse(data.originalTimestamp);
    if (Number.isFinite(t)) receivedAt = t;
  }
  const documentId = str(data.documentId) ?? str(data.lobbyName) ?? '';
  const documentIds = Array.isArray(data.documentIds)
    ? (data.documentIds as unknown[]).filter((d): d is string => typeof d === 'string')
    : (documentId ? [documentId] : []);
  const out: IncomingDocumentCall = {
    callId,
    callerId,
    callerName: str(data.callerName) ?? callerId,
    lobbyName: str(data.lobbyName) ?? documentId,
    targeted: !!(localUserId && targets.includes(localUserId)),
    kind: 'document-review',
    documentId,
    title: str(data.title) ?? 'Call',
    documentIds,
    participantCount: typeof data.participantCount === 'number' ? data.participantCount : 1,
    media: data.media === 'audio' ? 'audio' : 'video',
    receivedAt,
    expiresAt: receivedAt + ttlMs,
  };
  const avatar = str(data.callerAvatarUrl);
  if (avatar) out.callerAvatarUrl = avatar;
  const message = str(data.message);
  if (message) out.message = message;
  if (data.documentTitles && typeof data.documentTitles === 'object') out.documentTitles = data.documentTitles as Record<string, string>;
  if (Array.isArray(data.participants)) {
    out.participants = (data.participants as unknown[])
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as { userId?: unknown }).userId === 'string')
      .map((p) => ({
        userId: p.userId as string,
        displayName: str(p.displayName) ?? (p.userId as string),
        ...(str(p.avatarUrl) ? { avatarUrl: str(p.avatarUrl) } : {}),
      }));
  }
  return out;
}

export function useIncomingDocumentCalls(opts: UseIncomingDocumentCallsOptions): UseIncomingDocumentCallsResult {
  const gw = useDocumentCallGateway(opts.gateway);
  const ttlMs = opts.ttlMs ?? 60_000;
  const { localUserId } = opts;
  const onMissedRef = useRef(opts.onMissed);
  onMissedRef.current = opts.onMissed;
  const onAcceptRef = useRef(opts.onAccept);
  onAcceptRef.current = opts.onAccept;
  const gwRef = useRef(gw);
  gwRef.current = gw;

  const [queue, setQueue] = useState<IncomingDocumentCall[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const current = queue[0] ?? null;

  const onMessage = gw?.onMessage;
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: GatewayMessage) => {
      const f = asCallFrame(msg);
      if (!f) return;
      const callId = str(f.data.callId);
      if (!callId) return;
      if (f.action === 'ended' || f.action === 'cancelled' || f.action === 'accepted') {
        // Over, withdrawn, or answered on another of my tabs.
        setQueue((q) => q.filter((i) => i.callId !== callId));
        return;
      }
      if (f.action !== 'invite') return;
      const inv = parseDocumentInvite(f.data, localUserId, ttlMs);
      if (!inv || inv.expiresAt <= Date.now()) return;
      setQueue((q) => (q.some((i) => i.callId === inv.callId) ? q : [...q, inv]));
    });
  }, [onMessage, localUserId, ttlMs]);

  // The head of the queue ages out on its own timer.
  useEffect(() => {
    if (!current) return;
    const expiring = current;
    const t = setTimeout(() => {
      setQueue((q) => q.filter((i) => i.callId !== expiring.callId));
      onMissedRef.current?.(expiring);
    }, Math.max(0, expiring.expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, [current]);

  const pop = useCallback(() => {
    const head = queueRef.current[0] ?? null;
    if (head) setQueue((q) => q.filter((i) => i.callId !== head.callId));
    return head;
  }, []);

  const accept = useCallback((media: { micOn: boolean; cameraOn: boolean }) => {
    const head = pop();
    if (head) onAcceptRef.current?.(head, media);
    return head;
  }, [pop]);

  const decline = useCallback((reason: 'not-now' | 'busy') => {
    const head = pop();
    if (!head) return;
    gatewaySend(gwRef.current, {
      service: 'call',
      action: 'declined',
      callId: head.callId,
      lobbyName: head.lobbyName,
      callerId: head.callerId,
      targetUserIds: [head.callerId],
      ...(localUserId ? { userId: localUserId } : {}),
      reason,
    });
  }, [pop, localUserId]);

  const dismiss = useCallback(() => { pop(); }, [pop]);

  return { current, queue, queueLength: queue.length, accept, decline, dismiss };
}
