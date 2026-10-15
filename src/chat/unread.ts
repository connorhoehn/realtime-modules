// realtime-modules/src/chat/unread.ts
//
// 0.118 (lane R5): the "new messages" notification item per cursor holder.
// ChatService owns the whole life of the item: created when a message lands
// (client send OR server-side post — both reach `broadcastMessage` /
// `noteMessagePosted`) for each cursor holder who is not the sender, not
// watching, and is a reader of the channel RIGHT NOW; cleared when that
// holder's read receipt moves past it. The host supplies only the content
// (`describe`), the id scheme (`itemId`) and the read authority
// (`currentReaders`, already on the chat options).
//
// READ ADMISSION: the reader check is made fresh for each recipient
// immediately before the item is created, and never reused from the cursor
// listing. The notifications service then asks its own `admit` at delivery.

import type { AuthorityScope } from '../server-ws/authorityScope';
import type { ChatMessage } from './types';

/** The slice of NotificationService the unread items use. */
export interface ChatUnreadInbox {
    notifyUser(userId: string, input: ChatUnreadItem): Promise<unknown>;
    listForUser(userId: string): Promise<Array<{ id: string; timestamp?: string; read?: boolean; payload?: Record<string, unknown> }>>;
    markReadForUser(userId: string, ids: readonly string[]): Promise<void>;
}

export interface ChatUnreadItem {
    id: string;
    type: string;
    title: string;
    body?: string;
    timestamp: string;
    channel: string;
    payload: Record<string, unknown>;
    action?: { label: string; href?: string; onClickEvent?: string };
}

/** What the host decides about an item's content. Return null to give no item for this message. */
export interface ChatUnreadContent {
    title: string;
    body?: string;
    type?: string;
    payload?: Record<string, unknown>;
    action?: { label: string; href?: string; onClickEvent?: string };
}

export interface ChatUnreadOpts {
    /**
     * Where items go. Omitted: the `notifications()` service attached beside
     * chat. A function is resolved at use (a service attached later, or a
     * host-held reference); null/undefined from it means "no inbox yet".
     */
    notify?: ChatUnreadInbox | (() => ChatUnreadInbox | null | undefined);
    /** The item's id for a holder whose cursor is at `readAt` (null: never read). One item per stretch since the cursor. */
    itemId: (channel: string, readAt: string | null) => string;
    /** The item's content for the message that triggered it. */
    describe: (ev: { channel: string; message: ChatMessage; senderName?: string; recipient: string }) => ChatUnreadContent | null | Promise<ChatUnreadContent | null>;
    /** Users watching the channel right now (their open panel reads it); null: unknown. They get no item. */
    live?: (channel: string, userIds: readonly string[], scope?: AuthorityScope) => Promise<ReadonlySet<string> | null> | ReadonlySet<string> | null;
    /**
     * 0.120.1: which channels keep unread items. Return false for a channel
     * (a DM, a Social channel with no cursor holders) and a send there does no
     * unread work at all: no read-receipts read, no inbox read. Omitted: every
     * channel, as before. A throw is treated as false (fail closed).
     */
    channels?: (channel: string) => boolean;
    /** How far back an unread count looks. Default 50. */
    window?: number;
    /** Is this inbox record one of this channel's unread items? Default: `payload.chatUnread === channel`. */
    isItem?: (n: { payload?: Record<string, unknown> }, channel: string) => boolean;
}

export const CHAT_UNREAD_MARKER = 'chatUnread';
export const DEFAULT_UNREAD_WINDOW = 50;

export function defaultIsItem(n: { payload?: Record<string, unknown> }, channel: string): boolean {
    return n.payload?.[CHAT_UNREAD_MARKER] === channel;
}
