import type { GatewayMessage } from './types';
/** One person's read cursor, as the wire carries it. */
export interface ChatReadReceiptEntry {
    userId: string;
    displayName?: string;
    /** ISO-8601 — the timestamp of the newest message they have seen. */
    readAt: string;
    /** ISO-8601 — when their cursor last moved ("seen 09:07"). */
    updatedAt: string;
}
/** Why a channel keeps no receipts. */
export type ChatReceiptsDisabledReason = 'disabled' | 'open-channel' | 'unknown-roster' | 'too-many-members';
/** Anything the hook can take a read position from. */
export type ReadPosition = string | {
    id?: string;
    timestamp: string;
};
export interface UseChatReadReceiptsOpts {
    /**
     * Send/receive handles, when the caller holds the socket itself. Given,
     * the hook never touches GatewaySocketProvider context — which is what
     * lets it render in a subtree with no provider. Omit it and the hook
     * reads context; omit BOTH and it goes inert (no receipts, no-op
     * markRead) rather than throwing.
     */
    socket?: {
        send: (message: Record<string, unknown>) => void;
        onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
    };
    /**
     * The viewer. Their own cursor is dropped from `receipts` and from every
     * `readersOf` answer — "seen by you" is not information.
     */
    currentUserId?: string;
    /**
     * Is the panel genuinely being looked at: the window focused and this
     * chat the thing on screen. Combined with document visibility, this is
     * what gates the automatic send (rule 2 above). Default false — a host
     * that passes nothing sends nothing automatically and drives the hook
     * with `markRead()`.
     */
    active?: boolean;
    /**
     * The newest message the transcript currently shows. When it changes
     * while `active`, that is the read (rule 3 above). Pass `null` while the
     * transcript is empty or the user has scrolled away from the bottom.
     */
    newestMessage?: ReadPosition | null;
    /** Floor between automatic sends. Default 1000ms. */
    throttleMs?: number;
}
export interface UseChatReadReceiptsReturn {
    /** Everyone else's cursors, newest reader first. Empty when disabled. */
    receipts: ChatReadReceiptEntry[];
    /** Does this channel keep receipts at all? */
    enabled: boolean;
    /** Why not, when it does not. */
    reason: ChatReceiptsDisabledReason | null;
    /** Largest channel the server keeps receipts for — for the "off in big channels" copy. */
    limit: number | null;
    /** True until the first `receipts` frame for this channel arrives. */
    loading: boolean;
    /**
     * Say the viewer has read up to here. Takes a message, an ISO string, or
     * nothing (meaning now). Safe to call as often as you like: it never
     * sends a position at or behind the last one sent, and the server refuses
     * to move a cursor backwards regardless.
     */
    markRead: (upTo?: ReadPosition) => void;
    /** Who has read `message` — everyone whose cursor is at or past its timestamp. */
    readersOf: (message: ReadPosition) => ChatReadReceiptEntry[];
    /** `readersOf(message).length`, without building the array. */
    readCountOf: (message: ReadPosition) => number;
    /** Re-request the full roster of cursors. */
    refresh: () => void;
}
export declare function useChatReadReceipts(channel: string, opts?: UseChatReadReceiptsOpts): UseChatReadReceiptsReturn;
//# sourceMappingURL=useChatReadReceipts.d.ts.map