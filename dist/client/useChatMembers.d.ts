export type ChatMemberRole = 'owner' | 'member';
export interface ChatMemberEntry {
    userId: string;
    role: ChatMemberRole;
    addedBy: string;
    addedAt: string;
    historyFrom: string | null;
}
export interface ChatHistoryChoice {
    mode: 'none' | 'days' | 'all';
    days?: number;
}
export interface UseChatMembersReturn {
    members: ChatMemberEntry[];
    /** No membership rows: everyone the gateway admits is in it. */
    open: boolean;
    /** True until the first roster arrives for this channel. */
    loading: boolean;
    /** Add people; `names` lets the thread's system line name them. */
    addMembers: (userIds: string[], history: ChatHistoryChoice, names?: Record<string, string>) => void;
    removeMember: (userId: string, name?: string) => void;
    refresh: () => void;
    /** True when `userId` may read the channel: it is open, or they are an active member. */
    isMember: (userId: string) => boolean;
    /** Set when the gateway removed THIS connection from the channel (`{type:'chat', action:'removed'}`): who did it, and when. Cleared on a channel change. */
    removed: {
        byUserId: string;
        at: string;
    } | null;
}
export declare function useChatMembers(channel: string): UseChatMembersReturn;
export default useChatMembers;
//# sourceMappingURL=useChatMembers.d.ts.map