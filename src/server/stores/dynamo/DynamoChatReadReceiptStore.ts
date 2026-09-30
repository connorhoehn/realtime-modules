// realtime-modules/src/server/stores/dynamo/DynamoChatReadReceiptStore.ts
//
// The `chat-reads` table — ChatReadReceiptStore over DynamoDB, extracted from
// realtime-examples' DdbChatReadReceiptsStore. One CURSOR per
// (channel, person): the newest message time they have read.
//
//   - Partition key: `channel` (S)
//   - Sort key:      `userId` (S)
//   - `readAt` (S, ISO-8601), `updatedAt` (S, ISO-8601)
//   - `displayName` (S, optional)
//   - `ttl` (N, epoch seconds, +90 days)
//
// A separate table from chat-members on purpose: ChatService reads "no
// membership rows" as "open channel", so a cursor row there would close the
// channel behind its reader. Monotonic by one conditional Put.

import { DeleteItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { ChatReadReceipt, ChatReadReceiptStore } from '../../../chat/ChatReadReceiptStore';
import {
    CHAT_TTL_SECONDS,
    requireClient,
    requireTable,
    ttlFrom,
    type DynamoCommandClient,
    type DynamoStoreClockOpts,
    type DynamoStoreLogger,
} from './common';

export interface DynamoChatReadReceiptStoreOpts extends DynamoStoreClockOpts {
    client: DynamoCommandClient;
    tableName: string;
    logger?: DynamoStoreLogger;
}

export class DynamoChatReadReceiptStore implements ChatReadReceiptStore {
    private readonly client: DynamoCommandClient;
    readonly tableName: string;
    private readonly logger?: DynamoStoreLogger;
    private readonly now: () => number;
    private readonly ttlSeconds: number;

    constructor(opts: DynamoChatReadReceiptStoreOpts) {
        this.client = requireClient('DynamoChatReadReceiptStore', opts?.client);
        this.tableName = requireTable('DynamoChatReadReceiptStore', opts.tableName);
        this.logger = opts.logger;
        this.now = opts.now ?? Date.now;
        this.ttlSeconds = opts.ttlSeconds ?? CHAT_TTL_SECONDS;
    }

    /** Move the cursor forward, only forward. A refused write resolves null. */
    async advance(receipt: ChatReadReceipt): Promise<ChatReadReceipt | null> {
        const item: Record<string, any> = {
            channel: { S: receipt.channel },
            userId: { S: receipt.userId },
            readAt: { S: receipt.readAt },
            updatedAt: { S: receipt.updatedAt },
            ttl: { N: ttlFrom(this.now, this.ttlSeconds) },
        };
        if (receipt.displayName) item.displayName = { S: receipt.displayName };
        try {
            await this.client.send(new PutItemCommand({
                TableName: this.tableName,
                Item: item,
                ConditionExpression: 'attribute_not_exists(readAt) OR readAt < :readAt',
                ExpressionAttributeValues: { ':readAt': { S: receipt.readAt } },
            }));
            return { ...receipt };
        } catch (err: any) {
            if (err?.name === 'ConditionalCheckFailedException') return null;
            throw err;
        }
    }

    async listReceipts(channel: string): Promise<ChatReadReceipt[]> {
        const out: ChatReadReceipt[] = [];
        let ExclusiveStartKey: Record<string, any> | undefined;
        do {
            const res = await this.client.send(new QueryCommand({
                TableName: this.tableName,
                KeyConditionExpression: '#c = :c',
                ExpressionAttributeNames: { '#c': 'channel' },
                ExpressionAttributeValues: { ':c': { S: channel } },
                ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
            }));
            for (const item of res?.Items ?? []) out.push(receiptFromItem(item));
            ExclusiveStartKey = res?.LastEvaluatedKey;
        } while (ExclusiveStartKey);
        return out;
    }

    async deleteReceipt(channel: string, userId: string): Promise<void> {
        try {
            await this.client.send(new DeleteItemCommand({
                TableName: this.tableName,
                Key: { channel: { S: channel }, userId: { S: userId } },
            }));
        } catch (err: any) {
            // A stale cursor, not a failed removal — the service filters
            // receipts to current members before they reach the wire.
            this.logger?.warn?.('read receipt delete failed', { channel, userId, error: err?.message });
        }
    }
}

export function receiptFromItem(item: Record<string, any>): ChatReadReceipt {
    return {
        channel: item.channel?.S ?? '',
        userId: item.userId?.S ?? '',
        readAt: item.readAt?.S ?? '',
        updatedAt: item.updatedAt?.S ?? item.readAt?.S ?? '',
        ...(item.displayName?.S ? { displayName: item.displayName.S as string } : {}),
    };
}
