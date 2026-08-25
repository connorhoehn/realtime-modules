"use strict";
// realtime-modules/src/chat/index.ts
//
// Subpath entry — `@connorhoehn/realtime-modules/chat`.
//
// Lifted from gateway/src/realtime-fanout/chat-service.ts in Wave 2 / Cut 2.
// Consumers wire a `ChatStore` (defaults to InMemoryChatStore) and a
// `ChatMessageRouter` and get a ready-to-go ChatService.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DM_CHANNEL_NAME_MAX_LENGTH = exports.DM_GROUP_CHANNEL_PREFIX = exports.DM_CHANNEL_PREFIX = exports.dmChannelMembers = exports.dmChatChannelFor = exports.isDmChatChannel = exports.SubscriptionTracker = exports.InMemoryChatStore = exports.ChatManifest = exports.ChatService = void 0;
const ChatService_1 = __importDefault(require("./ChatService"));
exports.ChatService = ChatService_1.default;
const manifest_1 = require("./manifest");
Object.defineProperty(exports, "ChatManifest", { enumerable: true, get: function () { return manifest_1.ChatManifest; } });
const ChatStore_1 = require("./ChatStore");
Object.defineProperty(exports, "InMemoryChatStore", { enumerable: true, get: function () { return ChatStore_1.InMemoryChatStore; } });
const SubscriptionTracker_1 = require("./SubscriptionTracker");
Object.defineProperty(exports, "SubscriptionTracker", { enumerable: true, get: function () { return SubscriptionTracker_1.SubscriptionTracker; } });
const dmChannels_1 = require("./dmChannels");
Object.defineProperty(exports, "isDmChatChannel", { enumerable: true, get: function () { return dmChannels_1.isDmChatChannel; } });
Object.defineProperty(exports, "dmChatChannelFor", { enumerable: true, get: function () { return dmChannels_1.dmChatChannelFor; } });
Object.defineProperty(exports, "dmChannelMembers", { enumerable: true, get: function () { return dmChannels_1.dmChannelMembers; } });
Object.defineProperty(exports, "DM_CHANNEL_PREFIX", { enumerable: true, get: function () { return dmChannels_1.DM_CHANNEL_PREFIX; } });
Object.defineProperty(exports, "DM_GROUP_CHANNEL_PREFIX", { enumerable: true, get: function () { return dmChannels_1.DM_GROUP_CHANNEL_PREFIX; } });
Object.defineProperty(exports, "DM_CHANNEL_NAME_MAX_LENGTH", { enumerable: true, get: function () { return dmChannels_1.DM_CHANNEL_NAME_MAX_LENGTH; } });
exports.default = ChatService_1.default;
//# sourceMappingURL=index.js.map