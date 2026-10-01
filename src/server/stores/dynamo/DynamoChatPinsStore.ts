// Extracted from realtime-examples' DdbPinsStore. PK channelId, SK messageId,
// 90-day retention; authorization belongs to the host before these operations.
import { DeleteItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { comparePins, pinRecord, type ChatPinInput, type ChatPinsStore, type PinnedMessage } from '../../../chat/ChatPinsStore';
import { CHAT_TTL_SECONDS, requireClient, requireTable, type DynamoCommandClient, type DynamoStoreClockOpts } from './common';

export interface DynamoChatPinsStoreOpts extends DynamoStoreClockOpts {
    client: DynamoCommandClient;
    tableName: string;
}

export class DynamoChatPinsStore implements ChatPinsStore {
    private readonly client: DynamoCommandClient;
    readonly tableName: string;
    private readonly now: () => number;
    private readonly ttlSeconds: number;

    constructor(opts: DynamoChatPinsStoreOpts) {
        this.client = requireClient('DynamoChatPinsStore', opts?.client);
        this.tableName = requireTable('DynamoChatPinsStore', opts.tableName);
        this.now = opts.now ?? Date.now;
        this.ttlSeconds = opts.ttlSeconds ?? CHAT_TTL_SECONDS;
    }

    async pin(input: ChatPinInput): Promise<PinnedMessage> {
        const now = this.now();
        const record = pinRecord(input, now);
        const item = Object.fromEntries(Object.entries(record).map(([key, value]) => [key, { S: value }]));
        await this.client.send(new PutItemCommand({
            TableName: this.tableName,
            Item: { ...item, ttl: { N: String(Math.floor(now / 1000) + this.ttlSeconds) } },
        }));
        return record;
    }

    async unpin(channelId: string, messageId: string): Promise<void> {
        await this.client.send(new DeleteItemCommand({
            TableName: this.tableName, Key: { channelId: { S: channelId }, messageId: { S: messageId } },
        }));
    }

    async list(channelId: string): Promise<PinnedMessage[]> {
        const pins: PinnedMessage[] = [];
        const now = Math.floor(this.now() / 1000);
        let startKey: Record<string, any> | undefined;
        do {
            const result = await this.client.send(new QueryCommand({
                TableName: this.tableName, ConsistentRead: true,
                KeyConditionExpression: 'channelId = :channel',
                ExpressionAttributeValues: { ':channel': { S: channelId } },
                ...(startKey ? { ExclusiveStartKey: startKey } : {}),
            }));
            for (const item of result?.Items ?? []) {
                // Dynamo's TTL deletion is asynchronous. Expired rows must not
                // reappear between the expiry time and the background deletion.
                if (!item.messageId?.S || (item.ttl?.N && Number(item.ttl.N) <= now)) continue;
                pins.push({
                    channelId, messageId: item.messageId.S,
                    pinnedBy: item.pinnedBy?.S ?? '', pinnedAt: item.pinnedAt?.S ?? '',
                    preview: item.preview?.S ?? '', author: item.author?.S ?? '',
                    ...(item.sentAt?.S ? { sentAt: item.sentAt.S } : {}),
                });
            }
            startKey = result?.LastEvaluatedKey;
        } while (startKey);
        return pins.sort(comparePins);
    }
}
