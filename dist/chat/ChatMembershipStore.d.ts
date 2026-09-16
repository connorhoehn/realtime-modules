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
export declare class MemoryChatMembershipStore implements ChatMembershipStore {
    private readonly rows;
    listMembers(channel: string): Promise<ChatMember[]>;
    getMember(channel: string, userId: string): Promise<ChatMember | null>;
    putMember(member: ChatMember): Promise<void>;
    /** Test helper. */
    _reset(): void;
}
/** What the wire carries for one member: the row minus its channel and removal. */
export interface ChatMemberView {
    userId: string;
    role: ChatMemberRole;
    addedBy: string;
    addedAt: string;
    historyFrom: string | null;
}
export declare function memberView(m: ChatMember): ChatMemberView;
/** How much history a newly added member may read. */
export interface ChatHistoryChoice {
    mode: 'none' | 'days' | 'all';
    days?: number;
}
export declare const MAX_HISTORY_DAYS = 3650;
/** The floor a choice sets, relative to `now`. `all` is no floor. */
export declare function historyFloorFor(choice: ChatHistoryChoice, now?: number): string | null;
/** Parse a client's history choice; null when it is not one. */
export declare function parseHistoryChoice(raw: unknown): ChatHistoryChoice | null;
//# sourceMappingURL=ChatMembershipStore.d.ts.map