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
//   { service: 'reaction', action: 'remove', channel, emoji, targetId }
//
// Durable message reactions (rm >= 0.33): when the server wires a
// ReactionStore, a reaction carrying a targetId is state rather than an event.
// Two extra inbound frames carry that:
//   { type:'reaction', action:'reaction_history', success:true,
//     data:{ channel, reactions: Reaction[] } }   // replay on subscribe
//   { type:'reaction', action:'reaction_removed',
//     data:{ channel, targetId, emoji, userId, timestamp } }
// Servers without a store never send either, and `unreact` gets an error
// frame back — the ephemeral call-reaction behaviour is unchanged.
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

export interface UnreactOpts {
  /** Override the hook-level targetId for this single call. */
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
  /**
   * Take back your own reaction. Only targeted reactions are removable — a
   * floating call reaction is an event that already happened. Servers with no
   * durable reaction store reply with an error frame.
   */
  unreact: (emoji: string, opts?: UnreactOpts) => void;
  /**
   * React or un-react depending on whether `currentUserId` already has this
   * emoji on the target. This is what a reaction CHIP does — the chip is a
   * toggle, and deciding which way it goes needs the current list, which the
   * hook already holds.
   */
  toggle: (emoji: string, opts?: UnreactOpts & { userId: string }) => void;
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
        // Durable replay on subscribe: the server's stored reactions for the
        // channel, already in Reaction shape. REPLACES the list rather than
        // appending — it is the state, not more events.
        if (msg.action === 'reaction_history') {
          const data = (msg as Record<string, any>).data;
          if (data && data.channel === channelRef.current && Array.isArray(data.reactions)) {
            const parsed = (data.reactions as unknown[])
              .map((r) => asReaction(r as Record<string, unknown>))
              .filter(Boolean) as Reaction[];
            setAllReactions(parsed.slice(-MAX_REACTIONS));
          }
          return;
        }

        // Somebody took their reaction back. Matched on the durable key
        // (target, emoji, owner) — NOT on the reaction id, which differs
        // between the live broadcast and the replayed row for the same fact.
        if (msg.action === 'reaction_removed') {
          const data = (msg as Record<string, any>).data;
          if (data && data.channel === channelRef.current) {
            setAllReactions((prev) =>
              prev.filter(
                (r) =>
                  !(r.targetId === data.targetId && r.emoji === data.emoji && r.userId === data.userId),
              ),
            );
          }
          return;
        }

        // reaction_subscribed / reaction_sent / reaction_unsent /
        // available_reactions acks — no state change needed.
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
  // delivers reaction broadcasts to subscribed clients.
  useEffect(() => {
    setAllReactions([]);
    send({
      service: 'reaction',
      action: 'subscribe',
      channel,
    } satisfies ClientFramePayload<'client.reaction.subscribe'>);
    return () => {
      send({
        service: 'reaction',
        action: 'unsubscribe',
        channel,
      } satisfies ClientFramePayload<'client.reaction.unsubscribe'>);
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

  const unreact = useCallback(
    (emoji: string, unreactOpts?: UnreactOpts) => {
      const resolvedTargetId = unreactOpts?.targetId ?? targetIdRef.current;
      send({
        service: 'reaction',
        action: 'remove',
        channel: channelRef.current,
        emoji,
        targetId: resolvedTargetId,
      });
    },
    [send],
  );

  // Reads the CURRENT list through a ref so the callback identity stays
  // stable — a toggle that changes on every reaction would re-render every
  // chip in the channel each time anyone reacted.
  const allRef = useRef(allReactions);
  useEffect(() => {
    allRef.current = allReactions;
  }, [allReactions]);

  const toggle = useCallback(
    (emoji: string, toggleOpts?: UnreactOpts & { userId: string }) => {
      const resolvedTargetId = toggleOpts?.targetId ?? targetIdRef.current;
      const mine = allRef.current.some(
        (r) =>
          r.emoji === emoji &&
          r.targetId === resolvedTargetId &&
          r.userId === toggleOpts?.userId,
      );
      if (mine) unreact(emoji, { targetId: resolvedTargetId });
      else react(emoji, { targetId: resolvedTargetId });
    },
    [react, unreact],
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

  return { reactions, react, reactionsFor, unreact, toggle };
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
    userId: typeof raw.userId === 'string' ? raw.userId : undefined,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : undefined,
  };
}
