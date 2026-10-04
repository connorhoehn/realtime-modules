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

import { GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { ChatMember, ChatMembershipStore } from '../../../chat/ChatMembershipStore';
import { requireClient, requireTable, type DynamoCommandClient } from './common';

export interface DynamoChatMembershipStoreOpts {
    client: DynamoCommandClient;
    tableName: string;
}

export class DynamoChatMembershipStore implements ChatMembershipStore {
    private readonly client: DynamoCommandClient;
    readonly tableName: string;

    constructor(opts: DynamoChatMembershipStoreOpts) {
        this.client = requireClient('DynamoChatMembershipStore', opts?.client);
        this.tableName = requireTable('DynamoChatMembershipStore', opts.tableName);
    }

    async listMembers(channel: string): Promise<ChatMember[]> {
        const out: ChatMember[] = [];
        let ExclusiveStartKey: Record<string, any> | undefined;
        do {
            const res = await this.client.send(new QueryCommand({
                TableName: this.tableName,
                // Membership is authority, not a directory preview. Every
                // base-table page must observe a completed removal write.
                ConsistentRead: true,
                KeyConditionExpression: '#c = :c',
                ExpressionAttributeNames: { '#c': 'channel' },
                ExpressionAttributeValues: { ':c': { S: channel } },
                ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
            }));
            for (const item of res?.Items ?? []) out.push(memberFromItem(item));
            ExclusiveStartKey = res?.LastEvaluatedKey;
        } while (ExclusiveStartKey);
        return out;
    }

    async getMember(channel: string, userId: string): Promise<ChatMember | null> {
        const res = await this.client.send(new GetItemCommand({
            TableName: this.tableName,
            ConsistentRead: true,
            Key: { channel: { S: channel }, userId: { S: userId } },
        }));
        return res?.Item ? memberFromItem(res.Item) : null;
    }

    async putMember(m: ChatMember): Promise<void> {
        const item: Record<string, any> = {
            channel: { S: m.channel },
            userId: { S: m.userId },
            role: { S: m.role },
            addedBy: { S: m.addedBy },
            addedAt: { S: m.addedAt },
        };
        if (m.historyFrom) item.historyFrom = { S: m.historyFrom };
        if (m.removedAt) item.removedAt = { S: m.removedAt };
        await this.client.send(new PutItemCommand({ TableName: this.tableName, Item: item }));
    }
}

export function memberFromItem(item: Record<string, any>): ChatMember {
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
