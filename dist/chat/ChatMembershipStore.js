"use strict";
// realtime-modules/src/chat/ChatMembershipStore.ts
//
// Who is in a chat channel, and from when they may read it.
//
// A channel with NO membership rows is OPEN: anyone the gateway's authz
// admits may join, send and read everything — the shape every channel had
// before membership existed, so nothing already running changes behaviour.
// The first `addMembers` on an open channel writes the requester as its
// owner and closes it: from then on only active rows (removedAt null) may
// join, send or read, and each row's `historyFrom` is the earliest message
// timestamp that member may see — the Teams "include history from the last
// N days / all / none" choice, decided by whoever added them.
//
// DM channels (`chat:dm:a:b`) are member-addressed by name and never hold
// rows here; ChatService reports their members from the channel id.
//
// Interface + in-memory store live here; the DynamoDB adapter stays in the
// gateway beside DdbChatStore (same split as ChatStore).
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_HISTORY_DAYS = exports.MemoryChatMembershipStore = void 0;
exports.memberView = memberView;
exports.historyFloorFor = historyFloorFor;
exports.parseHistoryChoice = parseHistoryChoice;
/** Zero-config store for tests and embedded use; nothing survives the process. */
class MemoryChatMembershipStore {
    rows = new Map();
    async listMembers(channel) {
        const bucket = this.rows.get(channel);
        return bucket ? Array.from(bucket.values()).map((m) => ({ ...m })) : [];
    }
    async getMember(channel, userId) {
        const m = this.rows.get(channel)?.get(userId);
        return m ? { ...m } : null;
    }
    async putMember(member) {
        const bucket = this.rows.get(member.channel) ?? new Map();
        bucket.set(member.userId, { ...member });
        this.rows.set(member.channel, bucket);
    }
    /** Test helper. */
    _reset() {
        this.rows.clear();
    }
}
exports.MemoryChatMembershipStore = MemoryChatMembershipStore;
function memberView(m) {
    return { userId: m.userId, role: m.role, addedBy: m.addedBy, addedAt: m.addedAt, historyFrom: m.historyFrom };
}
exports.MAX_HISTORY_DAYS = 3650;
/** The floor a choice sets, relative to `now`. `all` is no floor. */
function historyFloorFor(choice, now = Date.now()) {
    if (choice.mode === 'all')
        return null;
    if (choice.mode === 'none')
        return new Date(now).toISOString();
    const days = Math.min(exports.MAX_HISTORY_DAYS, Math.max(1, Math.floor(Number(choice.days) || 1)));
    return new Date(now - days * 86_400_000).toISOString();
}
/** Parse a client's history choice; null when it is not one. */
function parseHistoryChoice(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const mode = raw.mode;
    if (mode === 'all' || mode === 'none')
        return { mode };
    if (mode === 'days') {
        const days = Number(raw.days);
        if (!Number.isFinite(days) || days < 1)
            return null;
        return { mode, days: Math.min(exports.MAX_HISTORY_DAYS, Math.floor(days)) };
    }
    return null;
}
//# sourceMappingURL=ChatMembershipStore.js.map