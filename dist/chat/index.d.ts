import ChatService, { type ChatServiceOpts, type ChatMessageRouter, type ChatLogger, type ChatSenderIdentity, type ChatIdentityResolver } from './ChatService';
import { ChatManifest } from './manifest';
import { InMemoryChatStore } from './ChatStore';
import { MemoryChatMembershipStore, historyFloorFor, parseHistoryChoice, memberView, MAX_HISTORY_DAYS } from './ChatMembershipStore';
import { SubscriptionTracker } from './SubscriptionTracker';
import { isDmChatChannel, dmChatChannelFor, dmChannelMembers, DM_CHANNEL_PREFIX, DM_GROUP_CHANNEL_PREFIX, DM_CHANNEL_NAME_MAX_LENGTH } from './dmChannels';
export { ChatService, ChatManifest, InMemoryChatStore, MemoryChatMembershipStore, historyFloorFor, parseHistoryChoice, memberView, MAX_HISTORY_DAYS, SubscriptionTracker, isDmChatChannel, dmChatChannelFor, dmChannelMembers, DM_CHANNEL_PREFIX, DM_GROUP_CHANNEL_PREFIX, DM_CHANNEL_NAME_MAX_LENGTH, };
export type { ChatServiceOpts, ChatMessageRouter, ChatLogger, ChatSenderIdentity, ChatIdentityResolver };
export type { ChatStore } from './ChatStore';
export type { ChatMembershipStore, ChatMember, ChatMemberRole, ChatMemberView, ChatHistoryChoice } from './ChatMembershipStore';
export type { ChatMessage, ChatHistoryQuery } from './types';
export default ChatService;
//# sourceMappingURL=index.d.ts.map