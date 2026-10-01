"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryChatPinsStore = exports.PIN_PREVIEW_MAX = void 0;
exports.pinRecord = pinRecord;
exports.comparePins = comparePins;
exports.PIN_PREVIEW_MAX = 140;
function pinRecord(input, now) {
    const flat = input.text.replace(/\s+/g, ' ').trim();
    return {
        channelId: input.channelId, messageId: input.messageId,
        pinnedBy: input.pinnedBy, pinnedAt: new Date(now).toISOString(),
        preview: flat.length > exports.PIN_PREVIEW_MAX ? flat.slice(0, exports.PIN_PREVIEW_MAX - 1) + '…' : flat,
        author: input.author,
        ...(input.sentAt?.trim() ? { sentAt: input.sentAt } : {}),
    };
}
function comparePins(a, b) {
    return b.pinnedAt.localeCompare(a.pinnedAt) || a.messageId.localeCompare(b.messageId);
}
/** Memory storage; an optional row getter supports resettable host fixtures. */
class MemoryChatPinsStore {
    rows;
    now;
    constructor(opts = {}) {
        const rows = [];
        this.rows = opts.rows ?? (() => rows);
        this.now = opts.now ?? Date.now;
    }
    async pin(input) {
        const record = pinRecord(input, this.now());
        const rows = this.rows();
        const index = rows.findIndex((p) => p.channelId === input.channelId && p.messageId === input.messageId);
        if (index < 0)
            rows.push(record);
        else
            rows[index] = record;
        return { ...record };
    }
    async unpin(channelId, messageId) {
        const rows = this.rows();
        const index = rows.findIndex((p) => p.channelId === channelId && p.messageId === messageId);
        if (index >= 0)
            rows.splice(index, 1);
    }
    async list(channelId) {
        return this.rows().filter((p) => p.channelId === channelId).map((p) => ({ ...p })).sort(comparePins);
    }
}
exports.MemoryChatPinsStore = MemoryChatPinsStore;
//# sourceMappingURL=ChatPinsStore.js.map