// The operations the parity test runs against BOTH realtime-examples' chat
// repositories (via app-driver.js, inside that repo) and this library's
// DynamoDB stores, with the same clock and the same canned DynamoDB answers.
// Each op records the commands sent (`constructor.name` + `input`) and the
// resolved value; the two transcripts must be identical.
//
// `store` names the app class / library table:
//   messages      DdbChatStore               / DynamoChatStore (ChatStore methods)
//   conversations DdbConversationsStore      / store.conversations
//   members       DdbChatMembershipStore     / store.members
//   reads         DdbChatReadReceiptsStore   / store.reads
//   hooks         server.ts's inline chat hooks (onChannelMessage,
//                 onMessageChanged, _indexSystemMessage) / store.chatOptions()
//                 + conversations.recordSystemMessage
'use strict';

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const DM = 'chat:dm:dev-dave:dev-eve';

const m = (over = {}) => ({
    id: 'msg-1', clientId: 'conn-1', channel: 'general', message: 'hello',
    timestamp: '2026-09-29T11:59:00.000Z', ...over,
});
const row = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'boolean' ? { BOOL: v } : { S: v }]));
const ccf = () => ({ name: 'ConditionalCheckFailedException', message: 'The conditional request failed' });

const ops = [
    // ---- chat-messages -------------------------------------------------
    { store: 'messages', method: 'putMessage', args: [m()] },
    { store: 'messages', method: 'putMessage', args: [m({ metadata: {} })] },
    { store: 'messages', method: 'putMessage', args: [m({ id: 'msg-2', userId: 'dev-hank', metadata: { displayName: 'Hank', mentions: ['dev-eve'] } })] },
    { store: 'messages', method: 'putMessage', args: [m({ id: 'msg-3', userId: 'dev-hank', message: '', metadata: { deleted: true }, editedAt: '2026-09-29T12:00:01.000Z', deletedAt: '2026-09-29T12:00:02.000Z' })] },
    { store: 'messages', method: 'putMessage', args: [m({ id: 'card-1', clientId: 'system', channel: DM, message: 'Dave created Plan', metadata: { kind: 'document', documentId: 'd1', title: 'Plan', system: true } })] },
    { store: 'messages', method: 'listMessages', args: ['general', 50], responses: [{ Items: [
        row({ channelId: 'general', messageId: 'msg-2', clientId: 'conn-2', message: 'two', timestamp: 't2', userId: 'dev-hank', metadata: '{"a":1}', editedAt: 'e2' }),
        row({ channelId: 'general', messageId: 'msg-1', clientId: 'conn-1', message: 'one', timestamp: 't1' }),
    ] }] },
    { store: 'messages', method: 'listMessages', args: ['empty', 10], responses: [{}] },
    { store: 'messages', method: 'updateMessage', args: ['general', 'msg-1', { message: 'edited', editedAt: 'e1' }],
        responses: [{ Attributes: row({ channelId: 'general', messageId: 'msg-1', clientId: 'conn-1', message: 'edited', timestamp: 't1', editedAt: 'e1', userId: 'dev-hank' }) }] },
    { store: 'messages', method: 'updateMessage', args: ['general', 'msg-1', { message: '', metadata: { deleted: true }, deletedAt: 'd1' }],
        responses: [{ Attributes: row({ channelId: 'general', messageId: 'msg-1', clientId: 'conn-1', message: '', timestamp: 't1', metadata: '{"deleted":true}', deletedAt: 'd1' }) }] },
    { store: 'messages', method: 'updateMessage', args: [DM, 'card-1', { message: 'Call ended', metadata: { kind: 'call', live: false, system: true } }], responses: [{ Attributes: row({ channelId: DM, messageId: 'card-1', message: 'Call ended' }) }] },
    { store: 'messages', method: 'updateMessage', args: ['general', 'nope', { message: 'x' }], errors: [ccf()] },
    { store: 'messages', method: 'updateMessage', args: ['general', 'msg-1', {}] },

    // ---- chat-conversations ----------------------------------------------
    { store: 'conversations', method: 'recordMessage', args: [{ channel: DM, members: ['dev-dave', 'dev-eve'], message: m({ channel: DM, userId: 'dev-dave', message: 'x'.repeat(200) }) }] },
    { store: 'conversations', method: 'recordMessage', args: [{ channel: 'room:design', members: ['dev-carol'], message: m({ channel: 'room:design' }) }] },
    { store: 'conversations', method: 'recordMessage', args: [{ channel: 'chat:dmg:abc', members: [], message: m() }] },
    { store: 'conversations', method: 'recordMessage', args: [{ channel: 'g', members: ['a', 'b'], message: m({ userId: 'a' }) }], errors: [{ name: 'Error', message: 'boom' }] },
    { store: 'conversations', method: 'recordJoin', args: ['room:design', 'dev-eve'] },
    { store: 'conversations', method: 'recordJoin', args: ['', 'dev-eve'] },
    { store: 'conversations', method: 'setPinned', args: ['dev-eve', 'room:design', true], responses: [{ Attributes: row({ userId: 'dev-eve', channel: 'room:design', peers: '["dev-eve"]', pinned: true }) }] },
    { store: 'conversations', method: 'setMuted', args: ['dev-eve', 'room:design', '2126-01-01T00:00:00.000Z'], responses: [{ Attributes: row({ channel: 'room:design', peers: 'not json', mutedUntil: '2126-01-01T00:00:00.000Z' }) }] },
    { store: 'conversations', method: 'setMuted', args: ['dev-eve', 'room:design', null] },
    { store: 'conversations', method: 'setUnreadFrom', args: ['dev-eve', 'room:design', 't1'] },
    { store: 'conversations', method: 'setUnreadFrom', args: ['dev-eve', 'room:design', null] },
    { store: 'conversations', method: 'setSection', args: ['dev-eve', 'room:design', 'Work — Q3'] },
    { store: 'conversations', method: 'setSection', args: ['dev-eve', 'room:design', null] },
    { store: 'conversations', method: 'mutedMembers', args: ['room:design', ['a', 'b', 'c', 'a', '']],
        responses: [{ Responses: { 'chat-conversations': [row({ userId: 'a', mutedUntil: '2126-01-01T00:00:00.000Z' }), row({ userId: 'b', mutedUntil: '2000-01-01T00:00:00.000Z' }), row({ userId: 'c' })] } }] },
    { store: 'conversations', method: 'mutedMembers', args: ['room:design', ['a']], errors: [{ name: 'Error', message: 'down' }] },
    { store: 'conversations', method: 'listUsersForChannel', args: ['room:design'],
        responses: [{ Items: [row({ userId: 'a' })], LastEvaluatedKey: { userId: { S: 'a' }, channel: { S: 'room:design' } } }, { Items: [row({ userId: 'b' }), {}] }] },
    { store: 'conversations', method: 'listUsersForChannel', args: ['room:design'], errors: [{ name: 'ValidationException', message: 'no index' }] },
    { store: 'conversations', method: 'listForUser', args: ['dev-eve', 500], responses: [{ Items: [
        row({ userId: 'dev-eve', channel: 'old', peers: '["dev-eve"]', lastMessageAt: '2026-01-01', lastMessagePreview: 'o' }),
        row({ userId: 'dev-eve', channel: 'new', peers: '["dev-eve","dev-dave"]', lastMessageAt: '2026-09-01', lastMessageUserId: 'dev-dave', section: 'Work', unreadFrom: 'u' }),
        row({ userId: 'dev-eve' }),
    ] }] },

    // ---- chat-members ----------------------------------------------------
    { store: 'members', method: 'putMember', args: [{ channel: 'room:x', userId: 'a', role: 'owner', addedBy: 'a', addedAt: 't', historyFrom: 'h', removedAt: null }] },
    { store: 'members', method: 'putMember', args: [{ channel: 'room:x', userId: 'b', role: 'member', addedBy: 'a', addedAt: 't', historyFrom: null, removedAt: 'r' }] },
    { store: 'members', method: 'getMember', args: ['room:x', 'a'], responses: [{ Item: row({ channel: 'room:x', userId: 'a', role: 'owner', addedBy: 'a', addedAt: 't' }) }] },
    { store: 'members', method: 'getMember', args: ['room:x', 'z'], responses: [{}] },
    { store: 'members', method: 'listMembers', args: ['room:x'],
        responses: [{ Items: [row({ channel: 'room:x', userId: 'a', role: 'weird' })], LastEvaluatedKey: { channel: { S: 'room:x' }, userId: { S: 'a' } } }, { Items: [row({ channel: 'room:x', userId: 'b', removedAt: 'r' })] }] },

    // ---- chat-reads ------------------------------------------------------
    { store: 'reads', method: 'advance', args: [{ channel: 'g', userId: 'a', readAt: 't2', updatedAt: 'u2', displayName: 'Ada' }] },
    { store: 'reads', method: 'advance', args: [{ channel: 'g', userId: 'a', readAt: 't1', updatedAt: 'u1' }], errors: [ccf()] },
    { store: 'reads', method: 'listReceipts', args: ['g'], responses: [{ Items: [row({ channel: 'g', userId: 'a', readAt: 't2' }), row({ channel: 'g', userId: 'b', readAt: 't1', updatedAt: 'u', displayName: 'Bo' })] }] },
    { store: 'reads', method: 'deleteReceipt', args: ['g', 'a'] },
    { store: 'reads', method: 'deleteReceipt', args: ['g', 'b'], errors: [{ name: 'Error', message: 'gone' }] },

    // ---- the index maintenance server.ts wires on ChatService -------------
    { store: 'hooks', method: 'onDmMessage', args: [{ channel: DM, members: ['dev-dave', 'dev-eve'], message: m({ channel: DM, userId: 'dev-dave' }) }] },
    { store: 'hooks', method: 'onChannelMessage', args: [{ channel: 'room:design', members: ['dev-eve', 'dev-carol'], message: m({ channel: 'room:design', userId: 'dev-carol' }) }] },
    { store: 'hooks', method: 'onChannelMessage', args: [{ channel: 'room:open', members: [], message: m({ channel: 'room:open' }) }] },
    // A DM edit: the members are the DM's name — both, never just the sender.
    { store: 'hooks', method: 'onMessageChanged', recipients: ['ignored-for-dm'], args: [{ channel: DM, kind: 'edited', message: m({ channel: DM, userId: 'dev-dave', message: 'edited', editedAt: 'e' }) }] },
    { store: 'hooks', method: 'onMessageChanged', recipients: [], args: [{ channel: DM, kind: 'deleted', message: m({ channel: DM, userId: 'dev-dave', message: '', deletedAt: 'd' }) }] },
    // A server card patched in place (updateSystemMessage → messageUpdated) has no userId.
    { store: 'hooks', method: 'onMessageChanged', recipients: [], args: [{ channel: DM, kind: 'edited', message: m({ id: 'card-1', clientId: 'system', channel: DM, message: 'Call ended', metadata: { kind: 'call', live: false, system: true } }) }] },
    { store: 'hooks', method: 'onMessageChanged', recipients: ['dev-eve', 'dev-zed'], args: [{ channel: 'room:design', kind: 'edited', message: m({ channel: 'room:design', userId: 'dev-carol', message: 'edited' }) }] },
    { store: 'hooks', method: 'onMessageChanged', recipients: [], args: [{ channel: 'chat:dmg:abcdef', kind: 'edited', message: m({ channel: 'chat:dmg:abcdef', userId: 'dev-dave' }) }] },
    { store: 'hooks', method: 'onChannelJoin', args: [{ channel: 'room:design', userId: 'dev-eve' }] },
    { store: 'hooks', method: 'channelAudience', args: ['room:design'], responses: [{ Items: [row({ userId: 'a' })] }] },
    // onDocumentCreated / call cards: postSystemMessage then _indexSystemMessage.
    { store: 'hooks', method: 'indexSystemMessage', args: [DM, m({ id: 'card-1', clientId: 'system', channel: DM, message: 'Dave created Plan', metadata: { kind: 'document', system: true } })] },
    { store: 'hooks', method: 'indexSystemMessage', args: ['room:design', m({ id: 'card-2', clientId: 'system', channel: 'room:design' })] },
    { store: 'hooks', method: 'indexSystemMessage', args: [DM, null] },
];

module.exports = { NOW, ops };
