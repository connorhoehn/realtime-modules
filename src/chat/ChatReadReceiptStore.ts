// realtime-modules/src/chat/ChatReadReceiptStore.ts
//
// Who has read how far in a chat channel.
//
// WHAT A RECEIPT IS HERE — a per-member READ CURSOR, not a per-message
// receipt. One row per (channel, userId) holding the timestamp of the
// newest message that person has seen. The alternative — a row per
// (message, reader) — is O(members x messages): a 10-person channel with
// 5,000 messages is 50,000 rows that all have to be written on the way in
// and read back on every history replay, and every one of them says
// something the cursor already implies. The cursor is O(members): ten rows,
// each overwritten in place.
//
// What the cursor CAN answer:
//   - "has <person> seen <message>?" — their readAt >= the message's
//     timestamp. That is the whole read-receipt UI: a per-message "seen by"
//     list, a tick on your own last message, an unread divider.
//   - "who is behind?" — everyone whose readAt is older than the newest
//     message.
// What it CANNOT answer:
//   - out-of-order reading. Someone who scrolls back and reads an old
//     message they had skipped does not get a receipt for it alone; the
//     model is "read up to here", and reading backwards changes nothing.
//   - WHEN a particular message was read. The cursor carries one time —
//     when it last moved — not one per message. "Carol read message 12 at
//     09:04" is not expressible; "Carol had read through 09:06 as of
//     09:07" is.
//   - an audit trail. A cursor is overwritten, so there is no history of
//     how it advanced. If a product ever needs "prove she opened it", that
//     is a different feature with different storage and different consent.
//
// The interface + in-memory implementation live here; the DynamoDB adapter
// stays in the gateway beside DdbChatMembershipStore — same split as
// ChatStore and ChatMembershipStore.

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
export class MemoryChatReadReceiptStore implements ChatReadReceiptStore {
    private readonly rows = new Map<string, Map<string, ChatReadReceipt>>();

    async advance(receipt: ChatReadReceipt): Promise<ChatReadReceipt | null> {
        const bucket = this.rows.get(receipt.channel) ?? new Map<string, ChatReadReceipt>();
        const current = bucket.get(receipt.userId);
        if (current && !isAfter(receipt.readAt, current.readAt)) return null;
        const next: ChatReadReceipt = { ...receipt };
        bucket.set(receipt.userId, next);
        this.rows.set(receipt.channel, bucket);
        return { ...next };
    }

    async listReceipts(channel: string): Promise<ChatReadReceipt[]> {
        const bucket = this.rows.get(channel);
        return bucket ? Array.from(bucket.values()).map((r) => ({ ...r })) : [];
    }

    async deleteReceipt(channel: string, userId: string): Promise<void> {
        this.rows.get(channel)?.delete(userId);
    }

    /** Test helper — clears every channel. Not part of ChatReadReceiptStore. */
    _reset(): void {
        this.rows.clear();
    }
}

/**
 * Is `candidate` strictly newer than `current`? Both are ISO-8601 strings,
 * which sort lexicographically when they are well-formed — but a store can
 * hold a value written by an older build with a different precision, so this
 * parses rather than trusting the string compare, and falls back to the
 * string compare only when a value will not parse.
 */
export function isAfter(candidate: string, current: string): boolean {
    const a = Date.parse(candidate);
    const b = Date.parse(current);
    if (Number.isFinite(a) && Number.isFinite(b)) return a > b;
    return candidate > current;
}
