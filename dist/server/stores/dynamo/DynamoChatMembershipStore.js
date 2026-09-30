"use strict";
// realtime-modules/src/server/stores/dynamo/DynamoChatMembershipStore.ts
//
// The `chat-members` table — ChatMembershipStore over DynamoDB, extracted
// from realtime-examples' DdbChatMembershipStore. One row per
// (channel, userId); a removed member keeps the row with `removedAt` so
// re-adding restores it. No TTL: membership is not a log.
//
//   - Partition key: `channel` (S)
//   - Sort key:      `userId` (S)
//   - `role` (S: owner|member), `addedBy` (S), `addedAt` (S, ISO-8601)
//   - `historyFrom` / `removedAt` (S, ISO-8601, optional)
Object.defineProperty(exports, "__esModule", { value: true });
exports.DynamoChatMembershipStore = void 0;
exports.memberFromItem = memberFromItem;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const common_1 = require("./common");
class DynamoChatMembershipStore {
    client;
    tableName;
    constructor(opts) {
        this.client = (0, common_1.requireClient)('DynamoChatMembershipStore', opts?.client);
        this.tableName = (0, common_1.requireTable)('DynamoChatMembershipStore', opts.tableName);
    }
    async listMembers(channel) {
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
                out.push(memberFromItem(item));
            ExclusiveStartKey = res?.LastEvaluatedKey;
        } while (ExclusiveStartKey);
        return out;
    }
    async getMember(channel, userId) {
        const res = await this.client.send(new client_dynamodb_1.GetItemCommand({
            TableName: this.tableName,
            Key: { channel: { S: channel }, userId: { S: userId } },
        }));
        return res?.Item ? memberFromItem(res.Item) : null;
    }
    async putMember(m) {
        const item = {
            channel: { S: m.channel },
            userId: { S: m.userId },
            role: { S: m.role },
            addedBy: { S: m.addedBy },
            addedAt: { S: m.addedAt },
        };
        if (m.historyFrom)
            item.historyFrom = { S: m.historyFrom };
        if (m.removedAt)
            item.removedAt = { S: m.removedAt };
        await this.client.send(new client_dynamodb_1.PutItemCommand({ TableName: this.tableName, Item: item }));
    }
}
exports.DynamoChatMembershipStore = DynamoChatMembershipStore;
function memberFromItem(item) {
    return {
        channel: item.channel?.S ?? '',
        userId: item.userId?.S ?? '',
        role: item.role?.S === 'owner' ? 'owner' : 'member',
        addedBy: item.addedBy?.S ?? '',
        addedAt: item.addedAt?.S ?? '',
        historyFrom: item.historyFrom?.S ?? null,
        removedAt: item.removedAt?.S ?? null,
    };
}
//# sourceMappingURL=DynamoChatMembershipStore.js.map