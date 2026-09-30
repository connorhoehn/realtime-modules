// Runs the parity scenario against realtime-examples' own chat repositories
// and prints the transcript as JSON. Executed by the parity test with
// `cwd` = the realtime-examples checkout so its adapters resolve their own
// dependencies (its @aws-sdk, its pinned realtime-modules):
//
//   node test/stores/dynamo/parity/app-driver.js <realtime-examples dir>
//
// The hooks mirror the closures realtime-examples' src/server.ts passes to
// ChatService (onDmMessage / onChannelMessage / onMessageChanged /
// onChannelJoin / channelAudience) and its `_indexSystemMessage`, verbatim
// in behaviour; they are inline there, so they cannot be imported.
'use strict';

const path = require('path');
const appDir = path.resolve(process.argv[2]);
require(require.resolve('ts-node', { paths: [appDir] })).register({
    transpileOnly: true,
    project: path.join(appDir, 'tsconfig.json'),
    compilerOptions: { module: 'commonjs', moduleResolution: 'node' },
});
const adapters = path.join(appDir, 'src/realtime-fanout/chat/adapters');
const { DdbChatStore } = require(path.join(adapters, 'DdbChatStore.ts'));
const { DdbConversationsStore } = require(path.join(adapters, 'DdbConversationsStore.ts'));
const { DdbChatMembershipStore } = require(path.join(adapters, 'DdbChatMembershipStore.ts'));
const { DdbChatReadReceiptsStore } = require(path.join(adapters, 'DdbChatReadReceiptsStore.ts'));
const { changedMessageIndexMembers } = require(path.join(adapters, 'conversationIndexMembers.ts'));
const { runScenario } = require('./run');

const logger = { warn() {}, error() {}, info() {} };

runScenario((client, op) => {
    const conversations = new DdbConversationsStore({ ddbClient: client, tableName: 'chat-conversations', logger });
    return {
        messages: new DdbChatStore({ ddbClient: client, tableName: 'chat-messages', logger }),
        conversations,
        members: new DdbChatMembershipStore({ ddbClient: client, tableName: 'chat-members' }),
        reads: new DdbChatReadReceiptsStore({ ddbClient: client, tableName: 'chat-reads', logger }),
        hooks: {
            onDmMessage: (info) => { void conversations.recordMessage(info).catch(() => {}); },
            onChannelMessage: (info) => {
                const sender = info.message?.userId;
                const indexed = { ...info, members: Array.from(new Set([...(sender ? [sender] : []), ...info.members])) };
                void conversations.recordMessage(indexed).catch(() => {});
            },
            onMessageChanged: (info) => {
                void (async () => {
                    const sender = info.message?.userId;
                    const recipients = !info.channel.startsWith('chat:dm') ? op.recipients ?? [] : [];
                    const members = changedMessageIndexMembers(info.channel, sender, recipients);
                    const shown = info.kind === 'deleted' ? { ...info.message, message: 'Message deleted' } : info.message;
                    await conversations.recordMessage({ channel: info.channel, members, message: shown });
                })().catch(() => {});
            },
            onChannelJoin: (info) => { void conversations.recordJoin(info.channel, info.userId).catch(() => {}); },
            channelAudience: async (channel) => (await conversations.listUsersForChannel(channel)) ?? [],
            indexSystemMessage: (channel, posted) => {
                if (!posted?.id) return;
                const members = changedMessageIndexMembers(channel, undefined, []);
                if (!members.length) return;
                void conversations.recordMessage({ channel, members, message: posted }).catch(() => {});
            },
        },
    };
}).then((out) => process.stdout.write(JSON.stringify(out, null, 1) + '\n'), (err) => { console.error(err); process.exit(1); });
