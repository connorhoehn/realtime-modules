"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DynamoChatPinsStore = void 0;
// Extracted from realtime-examples' DdbPinsStore. PK channelId, SK messageId,
// 90-day retention; authorization belongs to the host before these operations.
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const ChatPinsStore_1 = require("../../../chat/ChatPinsStore");
const common_1 = require("./common");
class DynamoChatPinsStore {
    client;
    tableName;
    now;
    ttlSeconds;
    constructor(opts) {
        this.client = (0, common_1.requireClient)('DynamoChatPinsStore', opts?.client);
        this.tableName = (0, common_1.requireTable)('DynamoChatPinsStore', opts.tableName);
        this.now = opts.now ?? Date.now;
        this.ttlSeconds = opts.ttlSeconds ?? common_1.CHAT_TTL_SECONDS;
    }
    async pin(input) {
        const now = this.now();
        const record = (0, ChatPinsStore_1.pinRecord)(input, now);
        const item = Object.fromEntries(Object.entries(record).map(([key, value]) => [key, { S: value }]));
        await this.client.send(new client_dynamodb_1.PutItemCommand({
            TableName: this.tableName,
            Item: { ...item, ttl: { N: String(Math.floor(now / 1000) + this.ttlSeconds) } },
        }));
        return record;
    }
    async unpin(channelId, messageId) {
        await this.client.send(new client_dynamodb_1.DeleteItemCommand({
            TableName: this.tableName, Key: { channelId: { S: channelId }, messageId: { S: messageId } },
        }));
    }
    async list(channelId) {
        const pins = [];
        const now = Math.floor(this.now() / 1000);
        let startKey;
        do {
            const result = await this.client.send(new client_dynamodb_1.QueryCommand({
                TableName: this.tableName, ConsistentRead: true,
                KeyConditionExpression: 'channelId = :channel',
                ExpressionAttributeValues: { ':channel': { S: channelId } },
                ...(startKey ? { ExclusiveStartKey: startKey } : {}),
            }));
            for (const item of result?.Items ?? []) {
                // Dynamo's TTL deletion is asynchronous. Expired rows must not
                // reappear between the expiry time and the background deletion.
                if (!item.messageId?.S || (item.ttl?.N && Number(item.ttl.N) <= now))
                    continue;
                pins.push({
                    channelId, messageId: item.messageId.S,
                    pinnedBy: item.pinnedBy?.S ?? '', pinnedAt: item.pinnedAt?.S ?? '',
                    preview: item.preview?.S ?? '', author: item.author?.S ?? '',
                    ...(item.sentAt?.S ? { sentAt: item.sentAt.S } : {}),
                });
            }
            startKey = result?.LastEvaluatedKey;
        } while (startKey);
        return pins.sort(ChatPinsStore_1.comparePins);
    }
}
exports.DynamoChatPinsStore = DynamoChatPinsStore;
//# sourceMappingURL=DynamoChatPinsStore.js.map