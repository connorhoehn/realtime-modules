import type { ChatStore } from '../chat/ChatStore';
import type { ChatMessage, ChatMessagePatch } from '../chat/types';
import type { ChatReadReceipt, ChatReadReceiptStore } from '../chat/ChatReadReceiptStore';
import { type ChatMembershipStore } from '../chat/ChatMembershipStore';
/** A ChatStore over `rows()` for every channel; copies in and out, so callers never alias a row. */
export declare class RowsChatStore implements ChatStore {
    private readonly rows;
    constructor(rows: () => ChatMessage[]);
    putMessage(message: ChatMessage): Promise<void>;
    listMessages(channel: string, limit: number): Promise<ChatMessage[]>;
    getMessage(channel: string, messageId: string): Promise<ChatMessage | null>;
    updateMessage(channel: string, messageId: string, patch: ChatMessagePatch): Promise<ChatMessage | null>;
}
/** Read cursors over `rows()`. A cursor only moves forward (`advance` answers null otherwise). */
export declare class RowsReadReceiptStore implements ChatReadReceiptStore {
    private readonly rows;
    constructor(rows: () => ChatReadReceipt[]);
    advance(receipt: ChatReadReceipt): Promise<ChatReadReceipt | null>;
    listReceipts(channel: string): Promise<ChatReadReceipt[]>;
    deleteReceipt(channel: string, userId: string): Promise<void>;
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
export declare function createRowsChatBackend(opts?: RowsChatBackendOptions): RowsChatBackend;
//# sourceMappingURL=rowsChatBackend.d.ts.map