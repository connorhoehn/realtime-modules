// realtime-modules/src/client/useReactions.ts
//
// useReactions(channel, opts?) — React hook for gateway emoji reactions.
//
// Returns:
//   reactions      — last 50 Reaction[] for the channel (or filtered to
//                    opts.targetId when provided), oldest first
//   react          — send a reaction emoji to the channel
//   reactionsFor   — utility: filter the full reaction list by targetId
//                    without re-subscribing
//
// WIRE CONTRACT (gateway-real, verified against the gateway's installed
// ReactionService.handleAction — hub#1497): the reaction verbs are
// subscribe | unsubscribe | send | getAvailable. The previously sent
// 'react' was NEVER accepted ("Unknown reaction action: react"). Broadcasts
// are only delivered to clients that subscribed to the channel, so the hook
// subscribes on mount / channel change and unsubscribes on cleanup.
//
// Inbound frame shapes (gateway ReactionService send-backs):
//   { type: 'reaction', action: 'reaction_received', data: Reaction }
//   { type: 'reaction', action: 'reaction_subscribed'|'reaction_sent'|...,
//     success: true, data }                          // acks — ignored
// Legacy flat shapes ({ type: 'reaction:new' } / { type: 'reaction:history' })
// are still parsed as a fallback for non-gateway servers. The gateway sends
// no reaction-history frame (reactions are ephemeral).
//
// Outbound frames (canonical declaration: @connorhoehn/event-catalog
// client-frames v0.3.56 — client.reaction.send; subscribe/unsubscribe are
// the verified gateway verbs but have no EC declarations yet, so those
// send-sites carry no `satisfies` annotations):
//   { service: 'reaction', action: 'subscribe',   channel }
//   { service: 'reaction', action: 'unsubscribe', channel }
//   { service: 'reaction', action: 'send', channel, emoji, targetId?, metadata? }
//
// targetId support (v0.7.6):
//   - useReactions(channel, { targetId }) — reactions is pre-filtered to that entity
//   - react(emoji, { targetId }) — per-call override; falls back to hook-level targetId
//   - reactionsFor(targetId) — filter on demand from the full channel list
//
// NOTE: gateway-side ReactionService must forward the targetId field from inbound
// frames to all subscribers for round-trip to work. The field passes through
// opaquely in the current implementation.

import { useState, useEffect, useRef, useCallback } from 'react';
import { useGateway } from './GatewaySocketProvider';
import type { Reaction } from './types';
import type { GatewayMessage } from './types';
// Type-only import — erased at build; the EC package stays a devDependency.
import type { ClientFramePayload } from '@connorhoehn/event-catalog/client-frames';

const MAX_REACTIONS = 50;

export interface UseReactionsOpts {
  /** Filter reactions to a specific entity (messageId, articleId, etc.). */
  targetId?: string;
}

export interface ReactOpts {
  /** Override the hook-level targetId for this single call. */
  targetId?: string;
  /** Arbitrary metadata forwarded to the gateway. */
  metadata?: Record<string, unknown>;
}

export interface UseReactionsReturn {
  /** Reactions on the channel, filtered to hook-level targetId when provided. */
  reactions: Reaction[];
  /** Send an emoji reaction. Per-call targetId/metadata can be supplied via opts. */
  react: (emoji: string, opts?: ReactOpts) => void;
  /** Utility: filter the full (unfiltered) channel reaction list by targetId. */
  reactionsFor: (targetId: string) => Reaction[];
}

export function useReactions(channel: string, opts?: UseReactionsOpts): UseReactionsReturn {
  const { send, onMessage } = useGateway();
  // allReactions holds every reaction for the channel (unfiltered).
  const [allReactions, setAllReactions] = useState<Reaction[]>([]);

  const channelRef = useRef(channel);
  useEffect(() => {
    channelRef.current = channel;
  }, [channel]);

  // Track hook-level targetId via ref so callbacks see the latest value without
  // needing to re-register the message handler on every opts change.
  const targetIdRef = useRef(opts?.targetId);
  useEffect(() => {
    targetIdRef.current = opts?.targetId;
  }, [opts?.targetId]);

  // Register inbound handler once.
  useEffect(() => {
    const unsubscribe = onMessage((msg: GatewayMessage) => {
      // Gateway-real envelope: { type: 'reaction', action: 'reaction_received',
      // data: Reaction }. The frame carries no top-level channel — the
      // Reaction in `data` does, so channel-filter on that.
      if (msg.type === 'reaction') {
        if (msg.action === 'reaction_received') {
          const raw = msg as Record<string, unknown>;
          const entry =
            raw.data && typeof raw.data === 'object'
              ? asReaction(raw.data as Record<string, unknown>)
              : null;
          if (entry && entry.channel === channelRef.current) {
            setAllReactions((prev) => {
              const next = [...prev, entry];
              return next.length > MAX_REACTIONS ? next.slice(next.length - MAX_REACTIONS) : next;
            });
          }
        }
        // reaction_subscribed / reaction_sent / available_reactions acks —
        // no state change needed.
        return;
      }

      // Legacy flat shapes (non-gateway servers) — kept as a fallback.
      if (msg.channel !== channelRef.current) return;

      if (msg.type === 'reaction:new') {
        const entry = asReaction(msg as Record<string, unknown>);
        if (entry) {
          // Keep bounded to MAX_REACTIONS — drop the oldest when over limit.
          setAllReactions((prev) => {
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
        setAllReactions(parsed.slice(-MAX_REACTIONS));
      }
    });
    return unsubscribe;
  }, [onMessage]);

  // Subscribe / unsubscribe when channel changes — the gateway only
  // delivers reaction broadcasts to subscribed clients. The subscribe verb
  // is gateway-verified; no EC declaration yet (hub#1497).
  useEffect(() => {
    setAllReactions([]);
    send({
      service: 'reaction',
      action: 'subscribe',
      channel,
    });
    return () => {
      send({
        service: 'reaction',
        action: 'unsubscribe',
        channel,
      });
    };
  }, [channel, send]);

  const react = useCallback(
    (emoji: string, reactOpts?: ReactOpts) => {
      const resolvedTargetId = reactOpts?.targetId ?? targetIdRef.current;
      const frame: ClientFramePayload<'client.reaction.send'> = {
        service: 'reaction',
        action: 'send',
        channel: channelRef.current,
        emoji,
      };
      if (resolvedTargetId !== undefined) frame.targetId = resolvedTargetId;
      if (reactOpts?.metadata !== undefined) frame.metadata = reactOpts.metadata;
      send(frame);
    },
    [send],
  );

  const reactionsFor = useCallback(
    (targetId: string): Reaction[] => allReactions.filter((r) => r.targetId === targetId),
    [allReactions],
  );

  // Apply hook-level targetId filter for the returned reactions list.
  const reactions =
    opts?.targetId !== undefined
      ? allReactions.filter((r) => r.targetId === opts.targetId)
      : allReactions;

  return { reactions, react, reactionsFor };
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
    targetId: typeof raw.targetId === 'string' ? raw.targetId : undefined,
  };
}
