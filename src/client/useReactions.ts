// realtime-modules/src/client/useReactions.ts
//
// useReactions(channel) — React hook for gateway emoji reactions.
//
// Returns:
//   reactions — last 50 Reaction[] for the channel (oldest first)
//   react     — send a reaction emoji to the channel
//
// Inbound frame shapes (gateway reaction service):
//   { type: 'reaction:new',     channel, ...Reaction }
//   { type: 'reaction:history', channel, reactions: Reaction[] }
//
// Outbound frames:
//   { service: 'reaction', action: 'react',   channel, emoji }
//   { service: 'reaction', action: 'history', channel, limit: number }

import { useState, useEffect, useRef, useCallback } from 'react';
import { useGateway } from './GatewaySocketProvider';
import type { Reaction } from './types';
import type { GatewayMessage } from './types';

const MAX_REACTIONS = 50;

export interface UseReactionsReturn {
  reactions: Reaction[];
  react: (emoji: string) => void;
}

export function useReactions(channel: string): UseReactionsReturn {
  const { send, onMessage } = useGateway();
  const [reactions, setReactions] = useState<Reaction[]>([]);

  const channelRef = useRef(channel);
  useEffect(() => {
    channelRef.current = channel;
  }, [channel]);

  // Register inbound handler once.
  useEffect(() => {
    const unsubscribe = onMessage((msg: GatewayMessage) => {
      if (msg.channel !== channelRef.current) return;

      if (msg.type === 'reaction:new') {
        const entry = asReaction(msg as Record<string, unknown>);
        if (entry) {
          // Keep bounded to MAX_REACTIONS — drop the oldest when over limit.
          setReactions((prev) => {
            const next = [...prev, entry];
            return next.length > MAX_REACTIONS ? next.slice(next.length - MAX_REACTIONS) : next;
          });
        }
      } else if (msg.type === 'reaction:history') {
        const raw = msg as Record<string, unknown>;
        const list = Array.isArray(raw.reactions) ? (raw.reactions as unknown[]) : [];
        const parsed = list
          .map((r) => asReaction(r as Record<string, unknown>))
          .filter(Boolean) as Reaction[];
        // Honour the bound even on history payloads.
        setReactions(parsed.slice(-MAX_REACTIONS));
      }
    });
    return unsubscribe;
  }, [onMessage]);

  // Reset reactions when channel changes.
  useEffect(() => {
    setReactions([]);
  }, [channel]);

  const react = useCallback(
    (emoji: string) => {
      send({ service: 'reaction', action: 'react', channel: channelRef.current, emoji });
    },
    [send],
  );

  return { reactions, react };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asReaction(raw: Record<string, unknown>): Reaction | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || typeof raw.clientId !== 'string') return null;
  if (typeof raw.channel !== 'string' || typeof raw.emoji !== 'string') return null;
  return {
    id: raw.id,
    clientId: raw.clientId,
    channel: raw.channel,
    emoji: raw.emoji,
    effect: typeof raw.effect === 'string' ? raw.effect : '',
    position: raw.position ?? null,
    metadata: (typeof raw.metadata === 'object' && raw.metadata !== null
      ? raw.metadata
      : {}) as Record<string, unknown>,
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
  };
}
