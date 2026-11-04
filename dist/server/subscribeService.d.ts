import type { RealtimeRouter } from './router';
/** The router slice this needs: membership, and that is all. */
export interface SubscribeRouter {
    subscribeToChannel(clientId: string, channel: string): Promise<boolean | void> | boolean | void;
    unsubscribeFromChannel(clientId: string, channel: string): Promise<void> | void;
    sendToClient(clientId: string, message: unknown): void;
}
/**
 * A feature that owns a channel namespace and its own subscribe gate
 * (0.143.0). Subscribe / unsubscribe frames for a channel under `prefix`
 * are handed to `service.handleAction` unchanged, so they meet the same
 * checks — and get the same acks and refusals — as that feature's own wire
 * service. `attachRealtime` delegates `pipeline:` to the `pipeline()`
 * feature, so the generic multiplexer cannot open a firehose it refuses.
 */
export interface SubscribeDelegate {
    prefix: string;
    service: {
        handleAction(clientId: string, action: string, data: Record<string, unknown>): Promise<void> | void;
    };
}
export interface SubscribeServiceOptions {
    delegates?: readonly SubscribeDelegate[];
}
export declare class SubscribeService {
    private readonly router;
    private readonly delegates;
    constructor(router: SubscribeRouter, opts?: SubscribeServiceOptions);
    handleAction(clientId: string, action: string, data: Record<string, unknown>): Promise<void>;
}
/** Build the service over a full RealtimeRouter. */
export declare function createSubscribeService(router: RealtimeRouter, opts?: SubscribeServiceOptions): SubscribeService;
//# sourceMappingURL=subscribeService.d.ts.map