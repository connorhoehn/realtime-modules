// realtime-modules/src/client/useChannel.ts
//
// useChannel(channel, opts?) — composite hook bundling all per-channel features.
//
// Returns a single object with chat, presence, reactions, and activity — each
// is the full hook result or null when the feature is disabled via opts.features.
//
// Default: all four features are enabled.
//
// Example:
//   const { chat, presence, reactions, activity } = useChannel('chat:my-room');
//   chat?.sendMessage('hi');
//   presence?.setStatus('away');
//
// Selective enable:
//   const { chat, presence } = useChannel('chat:my-room', {
//     features: { chat: true, presence: true, reactions: false, activity: false },
//   });
//
// NOTE: All four sub-hooks are called unconditionally to satisfy React's Rules
// of Hooks. When a feature flag is false, the hook still runs internally but
// its result is mapped to null in the returned object.

import { useChat } from './useChat';
import { usePresence } from './usePresence';
import { useReactions } from './useReactions';
import { useActivity } from './useActivity';
import type { UseChatReturn } from './useChat';
import type { UsePresenceReturn } from './usePresence';
import type { UseReactionsReturn, UseReactionsOpts } from './useReactions';
import type { UseActivityReturn } from './useActivity';

export interface UseChannelFeatures {
  chat?: boolean;
  presence?: boolean;
  reactions?: boolean;
  activity?: boolean;
}

export interface UseChannelOptions {
  /**
   * Per-feature opt-out map. Each key defaults to true (enabled).
   * Set a key to false to receive null for that feature in the result.
   */
  features?: UseChannelFeatures;
  /**
   * Passed through to useReactions as opts.targetId.
   * Filters the reactions list to a specific entity (messageId, articleId, etc.).
   */
  reactionsTargetId?: string;
}

export interface UseChannelResult {
  /** The channel string passed to the hook. */
  channel: string;
  /** Chat messages + sendMessage + loadHistory, or null when chat is disabled. */
  chat: UseChatReturn | null;
  /** Presence roster + setStatus + updateMetadata, or null when presence is disabled. */
  presence: UsePresenceReturn | null;
  /** Reactions list + react() + reactionsFor(), or null when reactions is disabled. */
  reactions: UseReactionsReturn | null;
  /** Activity events + loadHistory, or null when activity is disabled. */
  activity: UseActivityReturn | null;
}

/**
 * Composite hook that bundles useChat + usePresence + useReactions + useActivity
 * for a single channel. Reduces boilerplate for apps that want "all the channel
 * features" without wiring four separate hooks.
 *
 * Each sub-hook is opt-out via opts.features (all default to enabled).
 * Returns null for disabled features so consumers can safely optional-chain:
 *   chat?.sendMessage('hi')
 */
export function useChannel(channel: string, opts?: UseChannelOptions): UseChannelResult {
  const features: Required<UseChannelFeatures> = {
    chat: opts?.features?.chat ?? true,
    presence: opts?.features?.presence ?? true,
    reactions: opts?.features?.reactions ?? true,
    activity: opts?.features?.activity ?? true,
  };

  const reactionsOpts: UseReactionsOpts | undefined = opts?.reactionsTargetId
    ? { targetId: opts.reactionsTargetId }
    : undefined;

  // All four hooks are called unconditionally — React's Rules of Hooks require
  // hook call order to be stable across renders. Feature flags only gate whether
  // the result is exposed to the consumer.
  const chat = useChat(channel);
  const presence = usePresence(channel);
  const reactions = useReactions(channel, reactionsOpts);
  const activity = useActivity(channel);

  return {
    channel,
    chat: features.chat ? chat : null,
    presence: features.presence ? presence : null,
    reactions: features.reactions ? reactions : null,
    activity: features.activity ? activity : null,
  };
}
