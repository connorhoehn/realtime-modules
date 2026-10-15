"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RowsReadReceiptStore = exports.RowsChatStore = void 0;
exports.createRowsChatBackend = createRowsChatBackend;
const ChatMembershipStore_1 = require("../chat/ChatMembershipStore");
/** A ChatStore over `rows()` for every channel; copies in and out, so callers never alias a row. */
class RowsChatStore {
    rows;
    constructor(rows) {
        this.rows = rows;
    }
    async putMessage(message) {
        const rows = this.rows();
        const at = rows.findIndex((m) => m.channel === message.channel && m.id === message.id);
        const copy = structuredClone(message);
        if (at >= 0)
            rows[at] = copy;
        else
            rows.push(copy);
    }
    async listMessages(channel, limit) {
        const mine = this.rows().filter((m) => m.channel === channel)
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        return structuredClone(mine.slice(Math.max(0, mine.length - limit)));
    }
    async getMessage(channel, messageId) {
        const message = this.rows().find((m) => m.channel === channel && m.id === messageId);
        return message ? structuredClone(message) : null;
    }
    async updateMessage(channel, messageId, patch) {
        const row = this.rows().find((m) => m.channel === channel && m.id === messageId);
        if (!row)
            return null;
        Object.assign(row, structuredClone(patch));
        return structuredClone(row);
    }
}
exports.RowsChatStore = RowsChatStore;
/** Read cursors over `rows()`. A cursor only moves forward (`advance` answers null otherwise). */
class RowsReadReceiptStore {
    rows;
    constructor(rows) {
        this.rows = rows;
    }
    async advance(receipt) {
        const rows = this.rows();
        const at = rows.findIndex((r) => r.channel === receipt.channel && r.userId === receipt.userId);
        if (at >= 0 && !(receipt.readAt > rows[at].readAt))
            return null;
        const copy = structuredClone(receipt);
        if (at >= 0)
            rows[at] = copy;
        else
            rows.push(copy);
        return structuredClone(copy);
    }
    async listReceipts(channel) {
        return structuredClone(this.rows().filter((r) => r.channel === channel))
            .sort((a, b) => b.readAt.localeCompare(a.readAt));
    }
    async deleteReceipt(channel, userId) {
        const rows = this.rows();
        const at = rows.findIndex((r) => r.channel === channel && r.userId === userId);
        if (at >= 0)
            rows.splice(at, 1);
    }
}
exports.RowsReadReceiptStore = RowsReadReceiptStore;
/** Stores for `chat({ chatStore, readReceiptStore, membershipStore })`, rows resolved lazily on each call. */
function createRowsChatBackend(opts = {}) {
    const ownMessages = [];
    const ownReceipts = [];
    return {
        chatStore: new RowsChatStore(opts.messages ?? (() => ownMessages)),
        readReceiptStore: new RowsReadReceiptStore(opts.receipts ?? (() => ownReceipts)),
        membershipStore: opts.membershipStore ?? new ChatMembershipStore_1.MemoryChatMembershipStore(),
        reset() { ownMessages.length = 0; ownReceipts.length = 0; },
    };
}
//# sourceMappingURL=rowsChatBackend.js.map