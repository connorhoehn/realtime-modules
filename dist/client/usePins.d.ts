import type { PinnedMessage } from './GatewaySocketProvider';
export interface UsePinsResult {
    pins: PinnedMessage[];
    /** Ids only — what a message list needs to mark a message as pinned. */
    pinnedIds: Set<string>;
    pin: (input: {
        messageId: string;
        text: string;
        author: string;
    }) => Promise<void>;
    unpin: (messageId: string) => Promise<void>;
    refresh: () => void;
    /** True until the first read for the current channel settles. */
    isLoading: boolean;
    /**
     * The last failure, if any.
     *
     * A failed WRITE outranks a successful read, and stays until the next write
     * succeeds or the channel changes. Every write is followed by a reconciling
     * read, so an error the read could clear would be gone before anyone saw it
     * — the pin would roll back off the screen with no explanation, which is the
     * one thing worse than the write failing.
     */
    error?: Error;
}
export declare function usePins(channel: string | null | undefined): UsePinsResult;
export default usePins;
//# sourceMappingURL=usePins.d.ts.map