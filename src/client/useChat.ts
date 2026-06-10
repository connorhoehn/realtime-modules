// realtime-modules/src/client/useChat.ts
//
// useChat(channel) — React hook for gateway chat.
//
// Returns:
//   messages    — accumulated ChatMessage[] for the channel (newest last)
//   sendMessage — post a text message to the channel
//   loadHistory — fetch prior messages via the gateway HTTP history endpoint
//
// Inbound frame shapes (gateway chat service):
//   { type: 'chat:message',  channel, ...ChatMessage }
//   { type: 'chat:history',  channel, messages: ChatMessage[] }
//   { type: 'chat:joined',   channel }         // subscribe ack — ignored
//   { type: 'chat:error',    channel, error }  // ignored (surfaced at WS layer)
//
// Outbound frames (canonical declarations: @connorhoehn/event-catalog
// client-frames — client.chat.send / client.chat.history):
//   { service: 'chat', action: 'send',      channel, message: string }
//   { service: 'chat', action: 'history',   channel, limit: number }

import { useState, useEffect, useRef, useCallback } from 'react';
import { useGateway } from './GatewaySocketProvider';
import type { ChatMessage } from './types';
import type { GatewayMessage } from './types';
// Type-only import — erased at build; the EC package stays a devDependency.
import type { ClientFramePayload } from '@connorhoehn/event-catalog/client-frames';

export interface UseChatReturn {
  messages: ChatMessage[];
  sendMessage: (text: string) => void;
  loadHistory: (limit?: number) => void;
}

const DEFAULT_HISTORY_LIMIT = 50;

export function useChat(channel: string): UseChatReturn {
  const { send, onMessage } = useGateway();
  const [messages, setMessages] = useState<ChatMessage[]>([]);

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

      if (msg.type === 'chat:message') {
        // Single new message broadcast — append to tail.
        const entry = asChatMessage(msg);
        if (entry) {
          setMessages((prev) => [...prev, entry]);
        }
      } else if (msg.type === 'chat:history') {
        // History payload — replace current state with the ordered list.
        const raw = msg as Record<string, unknown>;
        const list = Array.isArray(raw.messages) ? (raw.messages as unknown[]) : [];
        const parsed = list.map(asChatMessageRaw).filter(Boolean) as ChatMessage[];
        setMessages(parsed);
      }
    });
    return unsubscribe;
  }, [onMessage]);

  // Reset messages when channel changes.
  useEffect(() => {
    setMessages([]);
  }, [channel]);

  const sendMessage = useCallback(
    (text: string) => {
      send({
        service: 'chat',
        action: 'send',
        channel: channelRef.current,
        message: text,
      } satisfies ClientFramePayload<'client.chat.send'>);
    },
    [send],
  );

  const loadHistory = useCallback(
    (limit: number = DEFAULT_HISTORY_LIMIT) => {
      send({
        service: 'chat',
        action: 'history',
        channel: channelRef.current,
        limit,
      } satisfies ClientFramePayload<'client.chat.history'>);
    },
    [send],
  );

  return { messages, sendMessage, loadHistory };
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
    channel: m.channel,
    message: m.message,
    metadata: typeof m.metadata === 'object' && m.metadata !== null
      ? (m.metadata as Record<string, unknown>)
      : undefined,
    timestamp: m.timestamp,
  };
}
