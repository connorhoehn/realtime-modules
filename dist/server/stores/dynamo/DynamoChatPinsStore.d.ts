import { type ChatPinInput, type ChatPinsStore, type PinnedMessage } from '../../../chat/ChatPinsStore';
import { type DynamoCommandClient, type DynamoStoreClockOpts } from './common';
export interface DynamoChatPinsStoreOpts extends DynamoStoreClockOpts {
    client: DynamoCommandClient;
    tableName: string;
}
export declare class DynamoChatPinsStore implements ChatPinsStore {
    private readonly client;
    readonly tableName: string;
    private readonly now;
    private readonly ttlSeconds;
    constructor(opts: DynamoChatPinsStoreOpts);
    pin(input: ChatPinInput): Promise<PinnedMessage>;
    unpin(channelId: string, messageId: string): Promise<void>;
    list(channelId: string): Promise<PinnedMessage[]>;
}
//# sourceMappingURL=DynamoChatPinsStore.d.ts.map