"use strict";
// realtime-modules/src/server/stores/dynamo/DynamoMessagesTable.ts
//
// The `chat-messages` table — a faithful extraction of realtime-examples'
// DdbChatStore (src/realtime-fanout/chat/adapters/DdbChatStore.ts). Rows it
// writes are the rows that app writes, attribute for attribute, so either
// can read the other's table with no migration:
//
//   - Partition key: `channelId` (S)                 — chat channel
//   - Sort key:      `messageId` (S)                 — application-generated id
//   - `clientId`     (S)                             — sender connection id
//   - `message`      (S)                             — message body
//   - `timestamp`    (S, ISO-8601)
//   - `metadata`     (S, JSON string)                — omitted when empty
//   - `userId`       (S, optional)                   — authenticated sender
//   - `editedAt` / `deletedAt` (S, ISO-8601, optional)
//   - `ttl`          (N, epoch seconds, +90 days)    — DynamoDB TTL
//
// listMessages queries newest-first then reverses, so the result is
// chronological (the ChatStore contract).
Object.defineProperty(exports, "__esModule", { value: true });
exports.DynamoMessagesTable = void 0;
exports.messageFromItem = messageFromItem;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const common_1 = require("./common");
class DynamoMessagesTable {
    client;
    tableName;
    now;
    ttlSeconds;
    constructor(opts) {
        this.client = (0, common_1.requireClient)('DynamoMessagesTable', opts?.client);
        this.tableName = (0, common_1.requireTable)('DynamoMessagesTable', opts.tableName);
        this.now = opts.now ?? Date.now;
        this.ttlSeconds = opts.ttlSeconds ?? common_1.CHAT_TTL_SECONDS;
    }
    async putMessage(message) {
        const item = {
            channelId: { S: message.channel },
            messageId: { S: message.id },
            clientId: { S: message.clientId },
            message: { S: message.message },
            timestamp: { S: message.timestamp },
            ttl: { N: (0, common_1.ttlFrom)(this.now, this.ttlSeconds) },
        };
        if (message.metadata && Object.keys(message.metadata).length > 0) {
            item.metadata = { S: JSON.stringify(message.metadata) };
        }
        // The author, so an edit or a delete after a restart can still be
        // authorised against the stored row (the cache is gone by then).
        if (message.userId)
            item.userId = { S: message.userId };
        if (message.editedAt)
            item.editedAt = { S: message.editedAt };
        if (message.deletedAt)
            item.deletedAt = { S: message.deletedAt };
        await this.client.send(new client_dynamodb_1.PutItemCommand({ TableName: this.tableName, Item: item }));
    }
    async listMessages(channel, limit) {
        const result = await this.client.send(new client_dynamodb_1.QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'channelId = :ch',
            ExpressionAttributeValues: { ':ch': { S: channel } },
            ScanIndexForward: false,
            Limit: limit,
        }));
        const items = (result?.Items || []).map(messageFromItem);
        // Query returned newest-first; reverse to chronological (oldest first).
        return items.reverse();
    }
    /**
     * An edit or a soft delete, in place on the existing row. Resolves null
     * for an unknown (channel, messageId) — the condition refuses to create a
     * row — or for an empty patch.
     */
    async updateMessage(channel, messageId, patch) {
        const sets = [];
        const names = {};
        const values = {};
        if (patch.message !== undefined) {
            sets.push('#message = :message');
            names['#message'] = 'message';
            values[':message'] = { S: patch.message };
        }
        if (patch.metadata !== undefined) {
            sets.push('#metadata = :metadata');
            names['#metadata'] = 'metadata';
            values[':metadata'] = { S: JSON.stringify(patch.metadata) };
        }
        if (patch.editedAt !== undefined) {
            sets.push('#editedAt = :editedAt');
            names['#editedAt'] = 'editedAt';
            values[':editedAt'] = { S: patch.editedAt };
        }
        if (patch.deletedAt !== undefined) {
            sets.push('#deletedAt = :deletedAt');
            names['#deletedAt'] = 'deletedAt';
            values[':deletedAt'] = { S: patch.deletedAt };
        }
        if (sets.length === 0)
            return null;
        try {
            const out = await this.client.send(new client_dynamodb_1.UpdateItemCommand({
                TableName: this.tableName,
                Key: { channelId: { S: channel }, messageId: { S: messageId } },
                UpdateExpression: `SET ${sets.join(', ')}`,
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
                ConditionExpression: 'attribute_exists(messageId)',
                ReturnValues: 'ALL_NEW',
            }));
            const item = out?.Attributes;
            if (!item)
                return null;
            return messageFromItem(item);
        }
        catch (err) {
            if (err?.name === 'ConditionalCheckFailedException')
                return null;
            throw err;
        }
    }
}
exports.DynamoMessagesTable = DynamoMessagesTable;
/** One stored row as a ChatMessage (metadata `{}` when the row has none). */
function messageFromItem(item) {
    return {
        id: item.messageId.S,
        clientId: item.clientId?.S ?? '',
        ...(item.userId?.S ? { userId: item.userId.S } : {}),
        channel: item.channelId.S,
        message: item.message?.S ?? '',
        metadata: item.metadata ? JSON.parse(item.metadata.S) : {},
        timestamp: item.timestamp?.S ?? '',
        ...(item.editedAt?.S ? { editedAt: item.editedAt.S } : {}),
        ...(item.deletedAt?.S ? { deletedAt: item.deletedAt.S } : {}),
    };
}
//# sourceMappingURL=DynamoMessagesTable.js.map