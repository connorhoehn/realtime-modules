import type { ChatReadReceipt, ChatReadReceiptStore } from '../../../chat/ChatReadReceiptStore';
import { type DynamoCommandClient, type DynamoStoreClockOpts, type DynamoStoreLogger } from './common';
export interface DynamoChatReadReceiptStoreOpts extends DynamoStoreClockOpts {
    client: DynamoCommandClient;
    tableName: string;
    logger?: DynamoStoreLogger;
}
export declare class DynamoChatReadReceiptStore implements ChatReadReceiptStore {
    private readonly client;
    readonly tableName: string;
    private readonly logger?;
    private readonly now;
    private readonly ttlSeconds;
    constructor(opts: DynamoChatReadReceiptStoreOpts);
    /** Move the cursor forward, only forward. A refused write resolves null. */
    advance(receipt: ChatReadReceipt): Promise<ChatReadReceipt | null>;
    listReceipts(channel: string): Promise<ChatReadReceipt[]>;
    deleteReceipt(channel: string, userId: string): Promise<void>;
}
export declare function receiptFromItem(item: Record<string, any>): ChatReadReceipt;
//# sourceMappingURL=DynamoChatReadReceiptStore.d.ts.map