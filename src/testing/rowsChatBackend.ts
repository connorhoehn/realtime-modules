// Rows-backed chat stores: every store reads its rows through a getter, so a
// host (or a test) can point them at a registered, resettable fixture and have
// a reset take every message back. Ported from aws-agentcore's social-chat.ts.
import type { ChatStore } from '../chat/ChatStore';
import type { ChatMessage, ChatMessagePatch } from '../chat/types';
import type { ChatReadReceipt, ChatReadReceiptStore } from '../chat/ChatReadReceiptStore';
import { MemoryChatMembershipStore, type ChatMembershipStore } from '../chat/ChatMembershipStore';

/** A ChatStore over `rows()` for every channel; copies in and out, so callers never alias a row. */
export class RowsChatStore implements ChatStore {
    constructor(private readonly rows: () => ChatMessage[]) {}

    async putMessage(message: ChatMessage): Promise<void> {
        const rows = this.rows();
        const at = rows.findIndex((m) => m.channel === message.channel && m.id === message.id);
        const copy = structuredClone(message);
        if (at >= 0) rows[at] = copy; else rows.push(copy);
    }

    async listMessages(channel: string, limit: number): Promise<ChatMessage[]> {
        const mine = this.rows().filter((m) => m.channel === channel)
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        return structuredClone(mine.slice(Math.max(0, mine.length - limit)));
    }

    async getMessage(channel: string, messageId: string): Promise<ChatMessage | null> {
        const message = this.rows().find((m) => m.channel === channel && m.id === messageId);
        return message ? structuredClone(message) : null;
    }

    async updateMessage(channel: string, messageId: string, patch: ChatMessagePatch): Promise<ChatMessage | null> {
        const row = this.rows().find((m) => m.channel === channel && m.id === messageId);
        if (!row) return null;
        Object.assign(row, structuredClone(patch));
        return structuredClone(row);
    }
}

/** Read cursors over `rows()`. A cursor only moves forward (`advance` answers null otherwise). */
export class RowsReadReceiptStore implements ChatReadReceiptStore {
    constructor(private readonly rows: () => ChatReadReceipt[]) {}

    async advance(receipt: ChatReadReceipt): Promise<ChatReadReceipt | null> {
        const rows = this.rows();
        const at = rows.findIndex((r) => r.channel === receipt.channel && r.userId === receipt.userId);
        if (at >= 0 && !(receipt.readAt > rows[at]!.readAt)) return null;
        const copy = structuredClone(receipt);
        if (at >= 0) rows[at] = copy; else rows.push(copy);
        return structuredClone(copy);
    }

    async listReceipts(channel: string): Promise<ChatReadReceipt[]> {
        return structuredClone(this.rows().filter((r) => r.channel === channel))
            .sort((a, b) => b.readAt.localeCompare(a.readAt));
    }

    async deleteReceipt(channel: string, userId: string): Promise<void> {
        const rows = this.rows();
        const at = rows.findIndex((r) => r.channel === channel && r.userId === userId);
        if (at >= 0) rows.splice(at, 1);
    }
}

export interface RowsChatBackendOptions {
    /** Message rows; defaults to a private array. */
    messages?: () => ChatMessage[];
    /** Read-receipt rows; defaults to a private array. */
    receipts?: () => ChatReadReceipt[];
    /** Membership store; defaults to `MemoryChatMembershipStore`. */
    membershipStore?: ChatMembershipStore;
}

export interface RowsChatBackend {
    chatStore: RowsChatStore;
    readReceiptStore: RowsReadReceiptStore;
    membershipStore: ChatMembershipStore;
    /** Drop every message and receipt held by the private arrays (a no-op for host-supplied getters). */
    reset(): void;
}

/** Stores for `chat({ chatStore, readReceiptStore, membershipStore })`, rows resolved lazily on each call. */
export function createRowsChatBackend(opts: RowsChatBackendOptions = {}): RowsChatBackend {
    const ownMessages: ChatMessage[] = [];
    const ownReceipts: ChatReadReceipt[] = [];
    return {
        chatStore: new RowsChatStore(opts.messages ?? (() => ownMessages)),
        readReceiptStore: new RowsReadReceiptStore(opts.receipts ?? (() => ownReceipts)),
        membershipStore: opts.membershipStore ?? new MemoryChatMembershipStore(),
        reset() { ownMessages.length = 0; ownReceipts.length = 0; },
    };
}
