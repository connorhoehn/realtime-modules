import type { Reaction } from './types';
import type { GatewayMessage } from './types';
export interface UseReactionsOpts {
    /** Filter reactions to a specific entity (messageId, articleId, etc.). */
    targetId?: string;
    /**
     * Send/receive handles, when the caller holds the socket itself. Given,
     * the hook never touches GatewaySocketProvider context — which is what
     * lets it render in a subtree that has no provider (a chat panel inside a
     * video call or a document, a component test with no provider wrapper).
     *
     * Shape matches what useGateway() returns for `send`/`onMessage`. When
     * omitted, the hook reads GatewaySocketProvider context exactly as before
     * (throws if there is no provider — unchanged for every existing caller).
     * When BOTH this and a provider are absent, the hook is inert: empty
     * reactions, no-op react/unreact/toggle. A chat panel with no gateway
     * anywhere in its tree should render without reactions, not crash.
     */
    socket?: {
        send: (message: Record<string, unknown>) => void;
        onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
    };
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
    toggle: (emoji: string, opts?: UnreactOpts & {
        userId: string;
    }) => void;
}
export declare function useReactions(channel: string, opts?: UseReactionsOpts): UseReactionsReturn;
//# sourceMappingURL=useReactions.d.ts.map