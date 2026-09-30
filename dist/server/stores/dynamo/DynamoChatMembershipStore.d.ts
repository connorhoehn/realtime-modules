import type { ChatMember, ChatMembershipStore } from '../../../chat/ChatMembershipStore';
import { type DynamoCommandClient } from './common';
export interface DynamoChatMembershipStoreOpts {
    client: DynamoCommandClient;
    tableName: string;
}
export declare class DynamoChatMembershipStore implements ChatMembershipStore {
    private readonly client;
    readonly tableName: string;
    constructor(opts: DynamoChatMembershipStoreOpts);
    listMembers(channel: string): Promise<ChatMember[]>;
    getMember(channel: string, userId: string): Promise<ChatMember | null>;
    putMember(m: ChatMember): Promise<void>;
}
export declare function memberFromItem(item: Record<string, any>): ChatMember;
//# sourceMappingURL=DynamoChatMembershipStore.d.ts.map