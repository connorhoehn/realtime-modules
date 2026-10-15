"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_UNREAD_WINDOW = exports.CHAT_UNREAD_MARKER = void 0;
exports.defaultIsItem = defaultIsItem;
exports.CHAT_UNREAD_MARKER = 'chatUnread';
exports.DEFAULT_UNREAD_WINDOW = 50;
function defaultIsItem(n, channel) {
    return n.payload?.[exports.CHAT_UNREAD_MARKER] === channel;
}
//# sourceMappingURL=unread.js.map