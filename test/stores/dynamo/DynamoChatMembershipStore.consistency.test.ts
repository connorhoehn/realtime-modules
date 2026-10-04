import { DynamoChatMembershipStore } from '../../../src/server/stores/dynamo';
import { makeDdbDouble } from './ddbDouble';

const channel = 'social:dm:alice:bob';
const row = { channel: { S: channel }, userId: { S: 'alice' }, role: { S: 'member' }, addedBy: { S: 'bob' }, addedAt: { S: '2026-10-03T12:00:00.000Z' }, removedAt: { S: '2026-10-03T13:00:00.000Z' } };

describe('public Dynamo membership authority reads', () => {
    test('getMember uses a strong base-table GetItem and preserves the removal tombstone', async () => {
        const ddb = makeDdbDouble();
        const store = new DynamoChatMembershipStore({ client: ddb, tableName: 'local-chat-members' });
        ddb.respondNext('GetItemCommand', { Item: row });
        expect(await store.getMember(channel, 'alice')).toMatchObject({ userId: 'alice', removedAt: '2026-10-03T13:00:00.000Z' });
        expect(ddb.sent[0]).toEqual({ name: 'GetItemCommand', input: { TableName: 'local-chat-members', ConsistentRead: true, Key: { channel: { S: channel }, userId: { S: 'alice' } } } });
    });

    test('every page of listMembers uses strong base-table Query, without a GSI', async () => {
        const ddb = makeDdbDouble();
        const store = new DynamoChatMembershipStore({ client: ddb, tableName: 'local-chat-members' });
        const key = { channel: { S: channel }, userId: { S: 'alice' } };
        ddb.respondNext('QueryCommand', { Items: [row], LastEvaluatedKey: key });
        ddb.respondNext('QueryCommand', { Items: [{ ...row, userId: { S: 'bob' } }] });
        expect(await store.listMembers(channel)).toHaveLength(2);
        expect(ddb.sent).toHaveLength(2);
        for (const command of ddb.sent) {
            expect(command.name).toBe('QueryCommand');
            expect(command.input.ConsistentRead).toBe(true);
            expect(command.input.IndexName).toBeUndefined();
        }
        expect(ddb.sent[1].input.ExclusiveStartKey).toEqual(key);
    });
});
