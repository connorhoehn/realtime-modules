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

export type ChatMemberRole = 'owner' | 'member';

export interface ChatMember {
    channel: string;
    userId: string;
    role: ChatMemberRole;
    /** Who added them; the owner of an open channel adds themselves. */
    addedBy: string;
    /** ISO. */
    addedAt: string;
    /** ISO floor on readable history; null = everything. */
    historyFrom: string | null;
    /** ISO when they were removed; null while active. A removed row keeps its place so re-adding restores it. */
    removedAt: string | null;
}

export interface ChatMembershipStore {
    /** Every row for the channel, removed ones included; [] when the channel is open. */
    listMembers(channel: string): Promise<ChatMember[]>;
    getMember(channel: string, userId: string): Promise<ChatMember | null>;
    /** Upsert on (channel, userId). */
    putMember(member: ChatMember): Promise<void>;
}

/** Zero-config store for tests and embedded use; nothing survives the process. */
export class MemoryChatMembershipStore implements ChatMembershipStore {
    private readonly rows = new Map<string, Map<string, ChatMember>>();

    async listMembers(channel: string): Promise<ChatMember[]> {
        const bucket = this.rows.get(channel);
        return bucket ? Array.from(bucket.values()).map((m) => ({ ...m })) : [];
    }

    async getMember(channel: string, userId: string): Promise<ChatMember | null> {
        const m = this.rows.get(channel)?.get(userId);
        return m ? { ...m } : null;
    }

    async putMember(member: ChatMember): Promise<void> {
        const bucket = this.rows.get(member.channel) ?? new Map<string, ChatMember>();
        bucket.set(member.userId, { ...member });
        this.rows.set(member.channel, bucket);
    }

    /** Test helper. */
    _reset(): void {
        this.rows.clear();
    }
}

/** What the wire carries for one member: the row minus its channel and removal. */
export interface ChatMemberView {
    userId: string;
    role: ChatMemberRole;
    addedBy: string;
    addedAt: string;
    historyFrom: string | null;
}

export function memberView(m: ChatMember): ChatMemberView {
    return { userId: m.userId, role: m.role, addedBy: m.addedBy, addedAt: m.addedAt, historyFrom: m.historyFrom };
}

/** How much history a newly added member may read. */
export interface ChatHistoryChoice {
    mode: 'none' | 'days' | 'all';
    days?: number;
}

export const MAX_HISTORY_DAYS = 3650;

/** The floor a choice sets, relative to `now`. `all` is no floor. */
export function historyFloorFor(choice: ChatHistoryChoice, now: number = Date.now()): string | null {
    if (choice.mode === 'all') return null;
    if (choice.mode === 'none') return new Date(now).toISOString();
    const days = Math.min(MAX_HISTORY_DAYS, Math.max(1, Math.floor(Number(choice.days) || 1)));
    return new Date(now - days * 86_400_000).toISOString();
}

/** Parse a client's history choice; null when it is not one. */
export function parseHistoryChoice(raw: unknown): ChatHistoryChoice | null {
    if (!raw || typeof raw !== 'object') return null;
    const mode = (raw as { mode?: unknown }).mode;
    if (mode === 'all' || mode === 'none') return { mode };
    if (mode === 'days') {
        const days = Number((raw as { days?: unknown }).days);
        if (!Number.isFinite(days) || days < 1) return null;
        return { mode, days: Math.min(MAX_HISTORY_DAYS, Math.floor(days)) };
    }
    return null;
}
