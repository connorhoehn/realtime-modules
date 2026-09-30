"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DynamoChatReadReceiptStore = void 0;
exports.receiptFromItem = receiptFromItem;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const common_1 = require("./common");
class DynamoChatReadReceiptStore {
    client;
    tableName;
    logger;
    now;
    ttlSeconds;
    constructor(opts) {
        this.client = (0, common_1.requireClient)('DynamoChatReadReceiptStore', opts?.client);
        this.tableName = (0, common_1.requireTable)('DynamoChatReadReceiptStore', opts.tableName);
        this.logger = opts.logger;
        this.now = opts.now ?? Date.now;
        this.ttlSeconds = opts.ttlSeconds ?? common_1.CHAT_TTL_SECONDS;
    }
    /** Move the cursor forward, only forward. A refused write resolves null. */
    async advance(receipt) {
        const item = {
            channel: { S: receipt.channel },
            userId: { S: receipt.userId },
            readAt: { S: receipt.readAt },
            updatedAt: { S: receipt.updatedAt },
            ttl: { N: (0, common_1.ttlFrom)(this.now, this.ttlSeconds) },
        };
        if (receipt.displayName)
            item.displayName = { S: receipt.displayName };
        try {
            await this.client.send(new client_dynamodb_1.PutItemCommand({
                TableName: this.tableName,
                Item: item,
                ConditionExpression: 'attribute_not_exists(readAt) OR readAt < :readAt',
                ExpressionAttributeValues: { ':readAt': { S: receipt.readAt } },
            }));
            return { ...receipt };
        }
        catch (err) {
            if (err?.name === 'ConditionalCheckFailedException')
                return null;
            throw err;
        }
    }
    async listReceipts(channel) {
        const out = [];
        let ExclusiveStartKey;
        do {
            const res = await this.client.send(new client_dynamodb_1.QueryCommand({
                TableName: this.tableName,
                KeyConditionExpression: '#c = :c',
                ExpressionAttributeNames: { '#c': 'channel' },
                ExpressionAttributeValues: { ':c': { S: channel } },
                ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
            }));
            for (const item of res?.Items ?? [])
                out.push(receiptFromItem(item));
            ExclusiveStartKey = res?.LastEvaluatedKey;
        } while (ExclusiveStartKey);
        return out;
    }
    async deleteReceipt(channel, userId) {
        try {
            await this.client.send(new client_dynamodb_1.DeleteItemCommand({
                TableName: this.tableName,
                Key: { channel: { S: channel }, userId: { S: userId } },
            }));
        }
        catch (err) {
            // A stale cursor, not a failed removal — the service filters
            // receipts to current members before they reach the wire.
            this.logger?.warn?.('read receipt delete failed', { channel, userId, error: err?.message });
        }
    }
}
exports.DynamoChatReadReceiptStore = DynamoChatReadReceiptStore;
function receiptFromItem(item) {
    return {
        channel: item.channel?.S ?? '',
        userId: item.userId?.S ?? '',
        readAt: item.readAt?.S ?? '',
        updatedAt: item.updatedAt?.S ?? item.readAt?.S ?? '',
        ...(item.displayName?.S ? { displayName: item.displayName.S } : {}),
    };
}
//# sourceMappingURL=DynamoChatReadReceiptStore.js.map