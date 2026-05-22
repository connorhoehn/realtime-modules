import type { UseChatReturn } from './useChat';
import type { UsePresenceReturn } from './usePresence';
import type { UseReactionsReturn } from './useReactions';
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
export declare function useChannel(channel: string, opts?: UseChannelOptions): UseChannelResult;
//# sourceMappingURL=useChannel.d.ts.map