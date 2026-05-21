import { type CallAction, type CallInvite, type CallLogger, type CallMessageRouter, type CallServiceOptions } from './types';
export declare class CallService {
    messageRouter: CallMessageRouter;
    logger: CallLogger;
    private authorize;
    private recordCallActionHook;
    constructor(opts: CallServiceOptions);
    handleAction(clientId: string, action: string, data: CallInvite | null | undefined): Promise<void>;
    handleCallEvent(clientId: string, action: CallAction, data: CallInvite | null | undefined): Promise<void>;
    /**
     * Pull the target user-id list out of a call payload, accepting either
     * the array form (`targetUserIds: string[]`) or the legacy single-target
     * shape (`targetUserId: string`). Returns a deduped array — empty means
     * the call should be broadcast.
     */
    normalizeTargetUserIds(payload: CallInvite): string[];
    /**
     * Return the clientIds of every connected client authenticated as any of
     * the provided userIds, excluding the sender. Delegates to MessageRouter's
     * `getClientsByUserId` seam — that method is the single chokepoint that
     * the cross-replica resolver swaps for a Redis-backed implementation.
     */
    findClientsForUsers(userIds: string[], excludeClientId: string): string[];
    /**
     * Fire the optional recordCallAction hook. Wrapped in try/catch so a
     * misbehaving consumer sink can never break call routing.
     */
    recordCallActionMetric(action: CallAction, targetKind: 'targeted' | 'broadcast'): void;
    handleDisconnect(_clientId: string): Promise<void>;
    sendError(clientId: string, message: string): void;
    getStats(): {
        stateful: false;
    };
}
export default CallService;
//# sourceMappingURL=CallService.d.ts.map