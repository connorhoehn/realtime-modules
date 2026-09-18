import type { RealtimeRouter } from './router';
/** The router slice this needs: membership, and that is all. */
export interface SubscribeRouter {
    subscribeToChannel(clientId: string, channel: string): Promise<boolean | void> | boolean | void;
    unsubscribeFromChannel(clientId: string, channel: string): Promise<void> | void;
    sendToClient(clientId: string, message: unknown): void;
}
export declare class SubscribeService {
    private readonly router;
    constructor(router: SubscribeRouter);
    handleAction(clientId: string, action: string, data: Record<string, unknown>): Promise<void>;
}
/** Build the service over a full RealtimeRouter. */
export declare function createSubscribeService(router: RealtimeRouter): SubscribeService;
//# sourceMappingURL=subscribeService.d.ts.map