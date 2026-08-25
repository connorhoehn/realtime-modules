// realtime-modules/src/chat/index.ts
//
// Subpath entry — `@connorhoehn/realtime-modules/chat`.
//
// Lifted from gateway/src/realtime-fanout/chat-service.ts in Wave 2 / Cut 2.
// Consumers wire a `ChatStore` (defaults to InMemoryChatStore) and a
// `ChatMessageRouter` and get a ready-to-go ChatService.

import ChatService, {
    type ChatServiceOpts,
    type ChatMessageRouter,
    type ChatLogger,
    type ChatSenderIdentity,
    type ChatIdentityResolver,
} from './ChatService';
import { ChatManifest } from './manifest';
import { InMemoryChatStore } from './ChatStore';
import { SubscriptionTracker } from './SubscriptionTracker';
import {
    isDmChatChannel,
    dmChatChannelFor,
    dmChannelMembers,
    DM_CHANNEL_PREFIX,
    DM_GROUP_CHANNEL_PREFIX,
    DM_CHANNEL_NAME_MAX_LENGTH,
} from './dmChannels';

export {
    ChatService,
    ChatManifest,
    InMemoryChatStore,
    SubscriptionTracker,
    // dm channel naming helpers (v0.23.0)
    isDmChatChannel,
    dmChatChannelFor,
    dmChannelMembers,
    DM_CHANNEL_PREFIX,
    DM_GROUP_CHANNEL_PREFIX,
    DM_CHANNEL_NAME_MAX_LENGTH,
};

export type { ChatServiceOpts, ChatMessageRouter, ChatLogger, ChatSenderIdentity, ChatIdentityResolver };
export type { ChatStore } from './ChatStore';
export type { ChatMessage, ChatHistoryQuery } from './types';

export default ChatService;
