// @connorhoehn/realtime-modules/server/stores/dynamo
//
// DynamoDB-backed chat persistence. Requires the optional peer
// `@aws-sdk/client-dynamodb` (v3); the consumer injects the client.

export { DynamoChatStore, DEFAULT_DYNAMO_CHAT_TABLES } from './DynamoChatStore';
export type { DynamoChatStoreOpts, DynamoChatTables, DynamoChatOptions, DynamoChatOptionsExtra } from './DynamoChatStore';
export { DynamoMessagesTable, messageFromItem } from './DynamoMessagesTable';
export type { DynamoMessagesTableOpts } from './DynamoMessagesTable';
export {
    DynamoConversationsStore,
    changedMessageIndexMembers,
    conversationRowFromItem,
    CONVERSATION_PREVIEW_MAX,
    CONVERSATIONS_CHANNEL_INDEX,
} from './DynamoConversationsStore';
export type { DynamoConversationsStoreOpts, ConversationRow, ConversationStatePatch } from './DynamoConversationsStore';
export { DynamoChatMembershipStore, memberFromItem } from './DynamoChatMembershipStore';
export type { DynamoChatMembershipStoreOpts } from './DynamoChatMembershipStore';
export { DynamoChatReadReceiptStore, receiptFromItem } from './DynamoChatReadReceiptStore';
export type { DynamoChatReadReceiptStoreOpts } from './DynamoChatReadReceiptStore';
export { DynamoChatPinsStore } from './DynamoChatPinsStore';
export type { DynamoChatPinsStoreOpts } from './DynamoChatPinsStore';
export { CHAT_TTL_SECONDS } from './common';
export type { DynamoCommandClient, DynamoStoreLogger, DynamoStoreClockOpts } from './common';
