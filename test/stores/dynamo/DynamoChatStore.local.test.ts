// DynamoChatStore against a real DynamoDB — DynamoDB Local from the
// realtime-examples Tilt stack (localhost:18000, or DYNAMODB_LOCAL_ENDPOINT).
// Skipped when nothing answers there. Creates four throwaway tables with a
// random suffix (the realtime-examples key schema, GSI included) and deletes
// them afterwards.
//
// What the double cannot show and this does: real UpdateExpression parsing
// (the reserved word `section`, if_not_exists), real conditions (a read
// cursor that refuses to go backwards, an edit of a missing message), the
// GSI, and that a DynamoDBDocumentClient carries the low-level commands.

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { execFileSync } from 'child_process';
import {
    CreateTableCommand,
    DeleteTableCommand,
    DynamoDBClient,
    GetItemCommand,
    waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ChatService } from '../../../src/chat/ChatService';
import { dmChatChannelFor } from '../../../src/chat/dmChannels';
import { DynamoChatStore, CHAT_TTL_SECONDS } from '../../../src/server/stores/dynamo';

const endpoint = process.env.DYNAMODB_LOCAL_ENDPOINT ?? 'http://localhost:18000';

function reachable(url: string): boolean {
    const { hostname, port } = new URL(url);
    try {
        execFileSync(process.execPath, ['-e', `
            const s = require('net').connect(${Number(port) || 80}, ${JSON.stringify(hostname)});
            s.setTimeout(1000, () => process.exit(1));
            s.on('connect', () => process.exit(0));
            s.on('error', () => process.exit(1));
        `], { timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

const up = reachable(endpoint);
const suffix = `-rm-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const tables = {
    messages: `chat-messages${suffix}`,
    conversations: `chat-conversations${suffix}`,
    members: `chat-members${suffix}`,
    reads: `chat-reads${suffix}`,
};

// The SDK's default Node handler reaches plain-http endpoints through a
// dynamic `import('node:http')`, which Jest's VM refuses without
// --experimental-vm-modules; the fetch handler (a client-dynamodb dependency)
// uses the global fetch instead.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FetchHttpHandler } = require('@smithy/fetch-http-handler');

const raw = new DynamoDBClient({
    endpoint,
    requestHandler: new FetchHttpHandler(),
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    maxAttempts: 2,
});
const doc = DynamoDBDocumentClient.from(raw);

const S = (AttributeName: string) => ({ AttributeName, AttributeType: 'S' as const });

(up ? describe : describe.skip)(`DynamoChatStore on DynamoDB Local (${endpoint})`, () => {
    beforeAll(async () => {
        const defs: Array<[string, string, string, boolean]> = [
            [tables.messages, 'channelId', 'messageId', false],
            [tables.conversations, 'userId', 'channel', true],
            [tables.members, 'channel', 'userId', false],
            [tables.reads, 'channel', 'userId', false],
        ];
        for (const [TableName, pk, sk, gsi] of defs) {
            await raw.send(new CreateTableCommand({
                TableName,
                BillingMode: 'PAY_PER_REQUEST',
                AttributeDefinitions: [S(pk), S(sk)],
                KeySchema: [{ AttributeName: pk, KeyType: 'HASH' }, { AttributeName: sk, KeyType: 'RANGE' }],
                ...(gsi ? {
                    GlobalSecondaryIndexes: [{
                        IndexName: 'channel-index',
                        KeySchema: [{ AttributeName: 'channel', KeyType: 'HASH' }],
                        Projection: { ProjectionType: 'ALL' },
                    }],
                } : {}),
            }));
            await waitUntilTableExists({ client: raw, maxWaitTime: 30 }, { TableName });
        }
    }, 60_000);

    afterAll(async () => {
        for (const TableName of Object.values(tables)) {
            try { await raw.send(new DeleteTableCommand({ TableName })); } catch { /* best effort */ }
        }
        raw.destroy();
    }, 30_000);

    for (const [kind, client] of [['DynamoDBClient', raw], ['DynamoDBDocumentClient', doc]] as const) {
        describe(`with a ${kind}`, () => {
            const tag = kind === 'DynamoDBClient' ? 'raw' : 'doc';
            const ch = `general-${tag}`;
            const store = () => new DynamoChatStore({ client, tables });

            it('puts, lists chronologically with a limit, edits and soft-deletes in place, with a 90-day ttl', async () => {
                const s = store();
                const before = Math.floor(Date.now() / 1000);
                for (const n of [1, 2, 3]) {
                    await s.putMessage({
                        id: `msg-${n}`, clientId: 'c1', userId: 'dev-hank', channel: ch, message: `m${n}`,
                        timestamp: `2026-09-29T12:00:0${n}.000Z`, metadata: n === 2 ? { kind: 'note' } : {},
                    });
                }
                expect((await s.listMessages(ch, 2)).map((m) => m.message)).toEqual(['m2', 'm3']);
                expect((await s.listMessages(ch, 10))[1]).toEqual({
                    id: 'msg-2', clientId: 'c1', userId: 'dev-hank', channel: ch, message: 'm2', metadata: { kind: 'note' }, timestamp: '2026-09-29T12:00:02.000Z',
                });
                const stored = await raw.send(new GetItemCommand({ TableName: tables.messages, Key: { channelId: { S: ch }, messageId: { S: 'msg-1' } } }));
                const ttl = Number(stored.Item!.ttl.N);
                expect(ttl).toBeGreaterThanOrEqual(before + CHAT_TTL_SECONDS);
                expect(ttl).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + CHAT_TTL_SECONDS);
                expect(stored.Item!.metadata).toBeUndefined();

                expect(await s.updateMessage(ch, 'msg-1', { message: 'edited', editedAt: 'e1' })).toMatchObject({ id: 'msg-1', message: 'edited', editedAt: 'e1', userId: 'dev-hank' });
                expect(await s.updateMessage(ch, 'msg-3', { message: '', metadata: { deleted: true }, deletedAt: 'd' })).toMatchObject({ message: '', metadata: { deleted: true }, deletedAt: 'd' });
                expect(await s.updateMessage(ch, 'missing', { message: 'x' })).toBeNull();
                expect(await s.listMessages(ch, 10)).toHaveLength(3);
            });

            it('keeps per-person conversation state across messages; section/mute/unread round-trip; the GSI answers the audience', async () => {
                const s = store();
                const c = `room:design-${tag}`;
                await s.conversations.setPinned('dev-eve', c, true);
                await s.conversations.setSection('dev-eve', c, 'Work');
                await s.conversations.setMuted('dev-eve', c, '2126-01-01T00:00:00.000Z');
                await s.conversations.recordJoin(c, 'dev-zed');
                await s.conversations.recordMessage({ channel: c, members: ['dev-eve', 'dev-carol'], message: { id: 'x', clientId: 'c', userId: 'dev-carol', channel: c, message: 'standup?', timestamp: '2026-09-29T12:00:00.000Z' } });
                const [row] = (await s.conversations.listForUser('dev-eve')).filter((r) => r.channel === c);
                expect(row).toMatchObject({ pinned: true, section: 'Work', mutedUntil: '2126-01-01T00:00:00.000Z', lastMessagePreview: 'standup?', lastMessageUserId: 'dev-carol', peers: ['dev-eve', 'dev-carol'] });
                expect([...await s.conversations.mutedMembers(c, ['dev-eve', 'dev-carol', 'dev-zed'])]).toEqual(['dev-eve']);
                expect((await s.conversations.setSection('dev-eve', c, null)).section).toBeNull();
                expect((await s.conversations.setUnreadFrom('dev-eve', c, '2026-09-29T11:00:00.000Z')).unreadFrom).toBe('2026-09-29T11:00:00.000Z');
                // DynamoDB Local's GSI is eventually consistent too; it is immediate in practice.
                expect((await s.conversations.listUsersForChannel(c)).sort()).toEqual(['dev-carol', 'dev-eve', 'dev-zed']);
            });

            it('membership and a monotonic read cursor', async () => {
                const s = store();
                const c = `room:closed-${tag}`;
                await s.members.putMember({ channel: c, userId: 'a', role: 'owner', addedBy: 'a', addedAt: 't', historyFrom: null, removedAt: null });
                await s.members.putMember({ channel: c, userId: 'b', role: 'member', addedBy: 'a', addedAt: 't', historyFrom: 'h', removedAt: 'r' });
                expect(await s.members.getMember(c, 'b')).toEqual({ channel: c, userId: 'b', role: 'member', addedBy: 'a', addedAt: 't', historyFrom: 'h', removedAt: 'r' });
                expect((await s.members.listMembers(c)).map((m) => m.userId)).toEqual(['a', 'b']);
                expect(await s.reads.advance({ channel: c, userId: 'a', readAt: '2026-09-29T12:00:02Z', updatedAt: 'u' })).not.toBeNull();
                expect(await s.reads.advance({ channel: c, userId: 'a', readAt: '2026-09-29T12:00:01Z', updatedAt: 'u' })).toBeNull();
                expect((await s.reads.listReceipts(c))[0].readAt).toBe('2026-09-29T12:00:02Z');
                await s.reads.deleteReceipt(c, 'a');
                expect(await s.reads.listReceipts(c)).toEqual([]);
            });

            it('chat(store.chatOptions()): a DM send and edit keep both members indexed with the pair as peers', async () => {
                const s = store();
                const svc = new ChatService({
                    messageRouter: {
                        redisAvailable: false,
                        sendToClient() {},
                        async sendToChannel() {},
                        async subscribeToChannel() { return true; },
                        async unsubscribeFromChannel() {},
                    } as any,
                    logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
                    identityResolver: (clientId: string) => ({ userId: clientId }),
                    ...s.chatOptions(),
                } as any);
                const dm = dmChatChannelFor([`dave-${tag}`, `eve-${tag}`]);
                await svc.handleAction(`dave-${tag}`, 'join', { channel: dm });
                await svc.handleAction(`dave-${tag}`, 'send', { channel: dm, message: 'hi' });
                const [sent] = await svc.getChannelHistory(dm, 10);
                await svc.handleAction(`dave-${tag}`, 'edit', { channel: dm, messageId: sent.id, message: 'hi!' });
                const deadline = Date.now() + 5000;
                let rows: Awaited<ReturnType<typeof s.conversations.listForUser>> = [];
                while (Date.now() < deadline) {
                    rows = (await s.conversations.listForUser(`eve-${tag}`)).filter((r) => r.channel === dm);
                    if (rows[0]?.lastMessagePreview === 'hi!') break;
                    await new Promise((r) => setTimeout(r, 50));
                }
                expect(rows[0]).toMatchObject({ lastMessagePreview: 'hi!', lastMessageUserId: `dave-${tag}` });
                expect(rows[0].peers.sort()).toEqual([`dave-${tag}`, `eve-${tag}`]);
                const fresh = new ChatService({ messageRouter: { redisAvailable: false } as any, logger: { debug() {}, info() {}, warn() {}, error() {} } as any, chatStore: store() } as any);
                expect((await fresh.getChannelHistory(dm, 10)).map((m) => m.message)).toEqual(['hi!']);
            });
        });
    }
});
