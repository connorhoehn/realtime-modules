/** A channel-scoped pin, independent of the sender's message metadata. */
export interface PinnedMessage {
    channelId: string;
    messageId: string;
    pinnedBy: string;
    pinnedAt: string;
    preview: string;
    author: string;
    /** The message's own send time. Never inferred from the pin time. */
    sentAt?: string;
}
export interface ChatPinInput {
    channelId: string;
    messageId: string;
    /** The authenticated subject, supplied by the host. */
    pinnedBy: string;
    text: string;
    author: string;
    sentAt?: string;
}
export interface ChatPinsStore {
    pin(input: ChatPinInput): Promise<PinnedMessage>;
    unpin(channelId: string, messageId: string): Promise<void>;
    /** Newest pin first, with message id as a deterministic tie breaker. */
    list(channelId: string): Promise<PinnedMessage[]>;
}
export declare const PIN_PREVIEW_MAX = 140;
export declare function pinRecord(input: ChatPinInput, now: number): PinnedMessage;
export declare function comparePins(a: PinnedMessage, b: PinnedMessage): number;
/** Memory storage; an optional row getter supports resettable host fixtures. */
export declare class MemoryChatPinsStore implements ChatPinsStore {
    private readonly rows;
    private readonly now;
    constructor(opts?: {
        rows?: () => PinnedMessage[];
        now?: () => number;
    });
    pin(input: ChatPinInput): Promise<PinnedMessage>;
    unpin(channelId: string, messageId: string): Promise<void>;
    list(channelId: string): Promise<PinnedMessage[]>;
}
//# sourceMappingURL=ChatPinsStore.d.ts.map