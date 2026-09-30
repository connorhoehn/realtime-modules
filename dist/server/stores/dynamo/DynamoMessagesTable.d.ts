import type { ChatMessage, ChatMessagePatch } from '../../../chat/types';
import type { ChatStore } from '../../../chat/ChatStore';
import { type DynamoCommandClient, type DynamoStoreClockOpts } from './common';
export interface DynamoMessagesTableOpts extends DynamoStoreClockOpts {
    client: DynamoCommandClient;
    tableName: string;
}
export declare class DynamoMessagesTable implements ChatStore {
    private readonly client;
    readonly tableName: string;
    private readonly now;
    private readonly ttlSeconds;
    constructor(opts: DynamoMessagesTableOpts);
    putMessage(message: ChatMessage): Promise<void>;
    listMessages(channel: string, limit: number): Promise<ChatMessage[]>;
    /**
     * An edit or a soft delete, in place on the existing row. Resolves null
     * for an unknown (channel, messageId) — the condition refuses to create a
     * row — or for an empty patch.
     */
    updateMessage(channel: string, messageId: string, patch: ChatMessagePatch): Promise<ChatMessage | null>;
}
/** One stored row as a ChatMessage (metadata `{}` when the row has none). */
export declare function messageFromItem(item: Record<string, any>): ChatMessage;
//# sourceMappingURL=DynamoMessagesTable.d.ts.map