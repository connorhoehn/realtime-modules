// realtime-modules/src/chat/index.ts
//
// Subpath entry — `@connorhoehn/realtime-modules/chat`.
//
// Lifted from gateway/src/realtime-fanout/chat-service.ts in Wave 2 / Cut 2.
// Consumers wire a `ChatStore` (defaults to InMemoryChatStore) and a
// `ChatMessageRouter` and get a ready-to-go ChatService.

import ChatService, { type ChatServiceOpts, type ChatMessageRouter, type ChatLogger } from './ChatService';
import { ChatManifest } from './manifest';
import { InMemoryChatStore } from './ChatStore';

export {
    ChatService,
    ChatManifest,
    InMemoryChatStore,
};

export type { ChatServiceOpts, ChatMessageRouter, ChatLogger };
export type { ChatStore } from './ChatStore';
export type { ChatMessage, ChatHistoryQuery } from './types';

export default ChatService;
