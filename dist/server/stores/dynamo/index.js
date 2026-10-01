"use strict";
// @connorhoehn/realtime-modules/server/stores/dynamo
//
// DynamoDB-backed chat persistence. Requires the optional peer
// `@aws-sdk/client-dynamodb` (v3); the consumer injects the client.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHAT_TTL_SECONDS = exports.DynamoChatPinsStore = exports.receiptFromItem = exports.DynamoChatReadReceiptStore = exports.memberFromItem = exports.DynamoChatMembershipStore = exports.CONVERSATIONS_CHANNEL_INDEX = exports.CONVERSATION_PREVIEW_MAX = exports.conversationRowFromItem = exports.changedMessageIndexMembers = exports.DynamoConversationsStore = exports.messageFromItem = exports.DynamoMessagesTable = exports.DEFAULT_DYNAMO_CHAT_TABLES = exports.DynamoChatStore = void 0;
var DynamoChatStore_1 = require("./DynamoChatStore");
Object.defineProperty(exports, "DynamoChatStore", { enumerable: true, get: function () { return DynamoChatStore_1.DynamoChatStore; } });
Object.defineProperty(exports, "DEFAULT_DYNAMO_CHAT_TABLES", { enumerable: true, get: function () { return DynamoChatStore_1.DEFAULT_DYNAMO_CHAT_TABLES; } });
var DynamoMessagesTable_1 = require("./DynamoMessagesTable");
Object.defineProperty(exports, "DynamoMessagesTable", { enumerable: true, get: function () { return DynamoMessagesTable_1.DynamoMessagesTable; } });
Object.defineProperty(exports, "messageFromItem", { enumerable: true, get: function () { return DynamoMessagesTable_1.messageFromItem; } });
var DynamoConversationsStore_1 = require("./DynamoConversationsStore");
Object.defineProperty(exports, "DynamoConversationsStore", { enumerable: true, get: function () { return DynamoConversationsStore_1.DynamoConversationsStore; } });
Object.defineProperty(exports, "changedMessageIndexMembers", { enumerable: true, get: function () { return DynamoConversationsStore_1.changedMessageIndexMembers; } });
Object.defineProperty(exports, "conversationRowFromItem", { enumerable: true, get: function () { return DynamoConversationsStore_1.conversationRowFromItem; } });
Object.defineProperty(exports, "CONVERSATION_PREVIEW_MAX", { enumerable: true, get: function () { return DynamoConversationsStore_1.CONVERSATION_PREVIEW_MAX; } });
Object.defineProperty(exports, "CONVERSATIONS_CHANNEL_INDEX", { enumerable: true, get: function () { return DynamoConversationsStore_1.CONVERSATIONS_CHANNEL_INDEX; } });
var DynamoChatMembershipStore_1 = require("./DynamoChatMembershipStore");
Object.defineProperty(exports, "DynamoChatMembershipStore", { enumerable: true, get: function () { return DynamoChatMembershipStore_1.DynamoChatMembershipStore; } });
Object.defineProperty(exports, "memberFromItem", { enumerable: true, get: function () { return DynamoChatMembershipStore_1.memberFromItem; } });
var DynamoChatReadReceiptStore_1 = require("./DynamoChatReadReceiptStore");
Object.defineProperty(exports, "DynamoChatReadReceiptStore", { enumerable: true, get: function () { return DynamoChatReadReceiptStore_1.DynamoChatReadReceiptStore; } });
Object.defineProperty(exports, "receiptFromItem", { enumerable: true, get: function () { return DynamoChatReadReceiptStore_1.receiptFromItem; } });
var DynamoChatPinsStore_1 = require("./DynamoChatPinsStore");
Object.defineProperty(exports, "DynamoChatPinsStore", { enumerable: true, get: function () { return DynamoChatPinsStore_1.DynamoChatPinsStore; } });
var common_1 = require("./common");
Object.defineProperty(exports, "CHAT_TTL_SECONDS", { enumerable: true, get: function () { return common_1.CHAT_TTL_SECONDS; } });
//# sourceMappingURL=index.js.map