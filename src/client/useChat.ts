// realtime-modules/src/client/useChat.ts
//
// useChat(channel) — React hook for gateway chat.
//
// Returns:
//   messages    — accumulated ChatMessage[] for the channel (newest last)
//   sendMessage — post a text message to the channel
//   loadHistory — explicitly re-request message history over the WS
//
// WIRE CONTRACT (gateway-real, verified against the gateway's installed
// ChatService.handleAction — hub#1497): the chat verbs are
// join | leave | send | history. The previously sent 'subscribe' was NEVER
// accepted ("Unknown chat action: subscribe"), and `send` requires a prior
// `join` on the channel ("You must join the channel before sending
// messages"). The hook therefore joins its channel on mount / channel
// change and leaves on cleanup. `join` auto-pushes recent channel history
// (chat/history frame) when any exists, so no explicit history request is
// sent on join — loadHistory remains for explicit re-fetch.
//
// Inbound frame shapes (gateway ChatService send-backs):
//   { type: 'chat', action: 'message', channel, message: ChatMessage }
//   { type: 'chat', action: 'history', channel, messages: ChatMessage[] }
//   { type: 'chat', action: 'joined'|'left'|'sent', channel }  // acks — ignored
// Legacy flat shapes ({ type: 'chat:message' } / { type: 'chat:history' })
// are still parsed as a fallback for non-gateway servers.
//
// Outbound frames (canonical declarations: @connorhoehn/event-catalog
// client-frames v0.3.56 — client.chat.join / client.chat.send /
// client.chat.history; `leave` is the verified gateway verb but has no EC
// declaration yet, so its send-site carries no `satisfies` annotation):
//   { service: 'chat', action: 'join',    channel }
//   { service: 'chat', action: 'leave',   channel }
//   { service: 'chat', action: 'send',    channel, message: string }
//   { service: 'chat', action: 'history', channel, limit?: number }
//     (limit omitted → gateway falls back to its configured default)

import { useState, useEffect, useRef, useCallback } from 'react';
import { useGateway } from './GatewaySocketProvider';
import type { ChatMessage } from './types';
import type { GatewayMessage } from './types';
// Type-only import — erased at build; the EC package stays a devDependency.
import type { ClientFramePayload } from '@connorhoehn/event-catalog/client-frames';

export interface UseChatReturn {
  messages: ChatMessage[];
  /**
   * Post to the channel. `metadata` rides the message verbatim, which is how
   * an attachment stays ORDERED with the text around it — the alternative, a
   * separate file-event stream, has to be merged back against the message
   * stream at render time and gets it wrong at exactly the moment it matters
   * (someone typing while a file uploads).
   */
  sendMessage: (text: string, metadata?: Record<string, unknown>) => void;
  loadHistory: (limit?: number) => void;
  /**
   * Who else is composing in this channel right now, by display name (or
   * user id when the server gave none). Never includes this connection.
   * An entry lapses on its own a few seconds after the last signal, so a
   * closed tab does not leave "Carol is typing…" on screen forever.
   */
  typingUsers: string[];
  /**
   * Say that this person is (or is no longer) composing. Throttled: while
   * typing, at most one frame every few seconds; a `false` goes out at once
   * and only if the channel was told `true`. Call it from the composer's
   * key handler and after every send.
   */
  setTyping: (typing: boolean) => void;
  /** Change one of your own messages; the gateway answers everyone with messageUpdated. */
  editMessage: (messageId: string, text: string, metadata?: Record<string, unknown>) => void;
  /** Take one of your own messages back; a soft delete everyone sees as messageDeleted. */
  deleteMessage: (messageId: string) => void;
}

/** How long a peer stays "typing" after their last signal. */
const TYPING_TTL_MS = 4_000;
/** How often a composing client re-announces itself. Under the TTL, so a steady typist never lapses. */
const TYPING_RESEND_MS = 2_500;

export function useChat(channel: string): UseChatReturn {
  const { send, onMessage, sessionEpoch } = useGateway();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Peers composing: connection id → { name, expiresAt }. Keyed by the
  // CONNECTION, so two tabs of one person count once each and each lapses
  // on its own.
  const typingRef = useRef<Map<string, { name: string; expiresAt: number }>>(new Map());
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const publishTyping = useCallback(() => {
    const now = Date.now();
    const names: string[] = [];
    const seen = new Set<string>();
    for (const [id, entry] of typingRef.current) {
      if (entry.expiresAt <= now) { typingRef.current.delete(id); continue; }
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      names.push(entry.name);
    }
    setTypingUsers((prev) => (prev.length === names.length && prev.every((n, i) => n === names[i]) ? prev : names));
  }, []);
  // Lapse on a timer, since no frame announces "stopped" when a tab closes.
  useEffect(() => {
    const t = setInterval(publishTyping, 1_000);
    return () => clearInterval(t);
  }, [publishTyping]);

  // Keep channel in a ref so the message handler always sees the latest value
  // without needing to be re-registered on every channel change.
  const channelRef = useRef(channel);
  useEffect(() => {
    channelRef.current = channel;
  }, [channel]);

  // Register inbound handler once; channel filtering uses channelRef.
  useEffect(() => {
    const unsubscribe = onMessage((msg: GatewayMessage) => {
      if (msg.channel !== channelRef.current) return;

      const raw = msg as Record<string, unknown>;

      // Gateway-real envelopes: { type: 'chat', action: 'message'|'history' }.
      if (msg.type === 'chat') {
        if (msg.action === 'message') {
          // Broadcast — the ChatMessage is nested under `message`.
          const entry = asChatMessageRaw(raw.message);
          if (entry) {
            setMessages((prev) => [...prev, entry]);
          }
        } else if (msg.action === 'history') {
          // History payload (explicit request OR auto-push on join) —
          // replace current state with the ordered list.
          const list = Array.isArray(raw.messages) ? (raw.messages as unknown[]) : [];
          const parsed = list.map(asChatMessageRaw).filter(Boolean) as ChatMessage[];
          setMessages(parsed);
        } else if (msg.action === 'messageUpdated') {
          const entry = asChatMessageRaw(raw.message);
          if (entry) {
            setMessages((prev) => prev.map((m) => (m.id === entry.id ? entry : m)));
          }
        } else if (msg.action === 'messageDeleted') {
          const id = typeof raw.messageId === 'string' ? raw.messageId : null;
          const deletedAt = typeof raw.deletedAt === 'string' ? raw.deletedAt : new Date().toISOString();
          if (id) {
            setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, message: '', metadata: { deleted: true }, deletedAt } : m)));
          }
        } else if (msg.action === 'typing') {
          // A peer composing (or done). The server never echoes our own.
          const id = typeof raw.clientId === 'string' ? raw.clientId : null;
          if (id) {
            if (raw.typing === true) {
              const name = (typeof raw.displayName === 'string' && raw.displayName)
                || (typeof raw.userId === 'string' && raw.userId)
                || 'Someone';
              typingRef.current.set(id, { name, expiresAt: Date.now() + TYPING_TTL_MS });
            } else {
              typingRef.current.delete(id);
            }
            publishTyping();
          }
        }
        // 'joined' / 'left' / 'sent' acks need no state change.
        return;
      }

      // Legacy flat shapes (non-gateway servers) — kept as a fallback.
      if (msg.type === 'chat:message') {
        const entry = asChatMessage(msg);
        if (entry) {
          setMessages((prev) => [...prev, entry]);
        }
      } else if (msg.type === 'chat:history') {
        const list = Array.isArray(raw.messages) ? (raw.messages as unknown[]) : [];
        const parsed = list.map(asChatMessageRaw).filter(Boolean) as ChatMessage[];
        setMessages(parsed);
      }
    });
    return unsubscribe;
  }, [onMessage]);

  // Join / leave the chat channel when it changes. The gateway requires a
  // join before send, and the join auto-pushes recent history (arriving as
  // a chat/history frame), so no explicit history request is needed here.
  useEffect(() => {
    setMessages([]);
    typingRef.current.clear();
    setTypingUsers([]);
    typingSentRef.current = { typing: false, at: 0 };
    send({
      service: 'chat',
      action: 'join',
      channel,
    } satisfies ClientFramePayload<'client.chat.join'>);
    return () => {
      send({
        service: 'chat',
        action: 'leave',
        channel,
      } satisfies ClientFramePayload<'client.chat.leave'>);
    };
      // sessionEpoch: a reconnect is a NEW server-side connection that has
    // joined nothing. Keyed only on `send` — a stable callback — this effect
    // would never fire again, and the hook would sit silently unsubscribed
    // while connectionState reads 'connected'.
  }, [channel, send, sessionEpoch]);

  // What this connection last told the channel about its own composing.
  const typingSentRef = useRef<{ typing: boolean; at: number }>({ typing: false, at: 0 });
  const setTyping = useCallback(
    (typing: boolean) => {
      const now = Date.now();
      const last = typingSentRef.current;
      if (typing) {
        if (last.typing && now - last.at < TYPING_RESEND_MS) return;
      } else if (!last.typing) {
        return;
      }
      typingSentRef.current = { typing, at: now };
      send({
        service: 'chat',
        action: 'typing',
        channel: channelRef.current,
        typing,
      } satisfies ClientFramePayload<'client.chat.typing'>);
    },
    [send],
  );

  const sendMessage = useCallback(
    (text: string, metadata?: Record<string, unknown>) => {
      send({
        service: 'chat',
        action: 'send',
        channel: channelRef.current,
        message: text,
        ...(metadata ? { metadata } : {}),
      } satisfies ClientFramePayload<'client.chat.send'>);
      // A sent message ends the composing, and the others should not wait
      // out the lapse to see that.
      if (typingSentRef.current.typing) {
        typingSentRef.current = { typing: false, at: Date.now() };
        send({ service: 'chat', action: 'typing', channel: channelRef.current, typing: false } satisfies ClientFramePayload<'client.chat.typing'>);
      }
    },
    [send],
  );

  const loadHistory = useCallback(
    (limit?: number) => {
      // limit is optional pass-through — when omitted the gateway falls
      // back to its configured default history limit.
      const frame: ClientFramePayload<'client.chat.history'> = {
        service: 'chat',
        action: 'history',
        channel: channelRef.current,
      };
      if (limit !== undefined) frame.limit = limit;
      send(frame);
    },
    [send],
  );

  const editMessage = useCallback(
    (messageId: string, text: string, metadata?: Record<string, unknown>) => {
      send({
        service: 'chat',
        action: 'edit',
        channel: channelRef.current,
        messageId,
        message: text,
        ...(metadata ? { metadata } : {}),
      } satisfies ClientFramePayload<'client.chat.edit'>);
    },
    [send],
  );

  const deleteMessage = useCallback(
    (messageId: string) => {
      send({
        service: 'chat',
        action: 'delete',
        channel: channelRef.current,
        messageId,
      } satisfies ClientFramePayload<'client.chat.delete'>);
    },
    [send],
  );

  return { messages, sendMessage, loadHistory, typingUsers, setTyping, editMessage, deleteMessage };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cast a GatewayMessage (typed as index type) to a ChatMessage, or null. */
function asChatMessage(msg: GatewayMessage): ChatMessage | null {
  return asChatMessageRaw(msg as unknown);
}

function asChatMessageRaw(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || typeof m.clientId !== 'string') return null;
  if (typeof m.channel !== 'string' || typeof m.message !== 'string') return null;
  if (typeof m.timestamp !== 'string') return null;
  return {
    id: m.id,
    clientId: m.clientId,
    userId: typeof m.userId === 'string' ? m.userId : undefined,
    channel: m.channel,
    message: m.message,
    metadata: typeof m.metadata === 'object' && m.metadata !== null
      ? (m.metadata as Record<string, unknown>)
      : undefined,
    timestamp: m.timestamp,
    ...(typeof m.editedAt === 'string' ? { editedAt: m.editedAt } : {}),
    ...(typeof m.deletedAt === 'string' ? { deletedAt: m.deletedAt } : {}),
  };
}
