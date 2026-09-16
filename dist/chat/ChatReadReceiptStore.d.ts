/** One person's read cursor in one channel. */
export interface ChatReadReceipt {
    channel: string;
    /** The authenticated subject (ChatMessage.userId), never a connection id. */
    userId: string;
    /**
     * ISO-8601. The timestamp of the newest message this person has seen —
     * they have read EVERYTHING in the channel at or before it. Monotonic:
     * it only ever moves forward (see `advance`).
     */
    readAt: string;
    /** ISO-8601. When the cursor last moved — the "seen at" a UI shows. */
    updatedAt: string;
    /** Presentation hint stamped from the reader's identity, as StoredReaction does. */
    displayName?: string;
}
export interface ChatReadReceiptStore {
    /**
     * Move one person's cursor forward. MONOTONIC BY CONTRACT: an
     * implementation must ignore a `readAt` at or before the stored one and
     * resolve `null`, so a second tab scrolled to an older message cannot
     * un-read the channel and cannot make the channel broadcast a receipt
     * that moves backwards. Resolves the stored receipt when it moved.
     *
     * Two tabs racing is the ordinary case, not the exotic one, which is why
     * the compare lives down here rather than as a read-then-write in the
     * service: a DynamoDB adapter does it in one call with
     * `ConditionExpression: attribute_not_exists(readAt) OR readAt < :readAt`.
     */
    advance(receipt: ChatReadReceipt): Promise<ChatReadReceipt | null>;
    /** Every cursor held for the channel. Order is not significant. */
    listReceipts(channel: string): Promise<ChatReadReceipt[]>;
    /**
     * Forget a person's cursor. Called when they leave (or are removed from)
     * the channel: a receipt is a statement about a member, and someone who
     * is no longer in the channel should not go on telling it who read what.
     * Deleting something that is not there is a no-op, not an error.
     */
    deleteReceipt(channel: string, userId: string): Promise<void>;
}
/** Zero-config store for tests and embedded use; nothing survives the process. */
export declare class MemoryChatReadReceiptStore implements ChatReadReceiptStore {
    private readonly rows;
    advance(receipt: ChatReadReceipt): Promise<ChatReadReceipt | null>;
    listReceipts(channel: string): Promise<ChatReadReceipt[]>;
    deleteReceipt(channel: string, userId: string): Promise<void>;
    /** Test helper — clears every channel. Not part of ChatReadReceiptStore. */
    _reset(): void;
}
/**
 * Is `candidate` strictly newer than `current`? Both are ISO-8601 strings,
 * which sort lexicographically when they are well-formed — but a store can
 * hold a value written by an older build with a different precision, so this
 * parses rather than trusting the string compare, and falls back to the
 * string compare only when a value will not parse.
 */
export declare function isAfter(candidate: string, current: string): boolean;
//# sourceMappingURL=ChatReadReceiptStore.d.ts.map