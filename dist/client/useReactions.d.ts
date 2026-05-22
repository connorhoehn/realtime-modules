import type { Reaction } from './types';
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
export declare function useReactions(channel: string, opts?: UseReactionsOpts): UseReactionsReturn;
//# sourceMappingURL=useReactions.d.ts.map