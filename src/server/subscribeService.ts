// realtime-modules/src/server/subscribeService.ts
//
// The generic multiplexer: `{ service: 'subscribe', action: 'subscribe' |
// 'unsubscribe', channel }`.
//
// This is not a feature. It is channel membership itself — the primitive every
// feature service already reaches for through the router — which is why
// `attachRealtime` registers it unconditionally rather than making it
// something you attach.
//
// It was missing entirely, and what that cost is easy to miss: useWebSocket's
// `subscribe()` / `unsubscribe()` are the low-level hook's whole channel API,
// and `autoResubscribe` replays them on every reconnect. Against
// attachRealtime each one came back SERVICE_NOT_AVAILABLE, so a consumer
// wiring channels by hand — rather than through a feature hook — had nothing
// happen, forever, and a reconnect re-sent the same refused frames.
//
// The wire shape is not invented here. @connorhoehn/event-catalog declares
// both directions: `client.subscribe.{subscribe,unsubscribe}` outbound and
// `ws.subscribe.{subscribed,unsubscribed}` inbound.
//
// The ack asymmetry is the catalog's, and it is deliberate. Its note on
// `ws.subscribe.subscribed` says the frame's ABSENCE carries meaning: a
// denied subscribe gets no ack, so "no ack" must not be read as "probably
// fine". Unsubscribe is unconditional and idempotent — leaving a channel has
// no authz gate and the router no-ops for a channel you were never on.

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
    service: { handleAction(clientId: string, action: string, data: Record<string, unknown>): Promise<void> | void };
}

export interface SubscribeServiceOptions {
    delegates?: readonly SubscribeDelegate[];
}

export class SubscribeService {
    private readonly delegates: readonly SubscribeDelegate[];

    constructor(private readonly router: SubscribeRouter, opts: SubscribeServiceOptions = {}) {
        this.delegates = (opts.delegates ?? []).filter((d) => d && typeof d.prefix === 'string' && d.prefix.length > 0 && d.service);
    }

    async handleAction(
        clientId: string,
        action: string,
        data: Record<string, unknown>,
    ): Promise<void> {
        const channel = typeof data.channel === 'string' ? data.channel : '';
        if (!channel) {
            this.router.sendToClient(clientId, {
                type: 'error',
                service: 'subscribe',
                code: 'INVALID_PAYLOAD',
                message: 'channel is required',
                timestamp: new Date().toISOString(),
            });
            return;
        }

        if (action === 'subscribe' || action === 'unsubscribe') {
            const delegate = this.delegates.find((d) => channel.startsWith(d.prefix));
            if (delegate) {
                await delegate.service.handleAction(clientId, action, { ...data, channel });
                return;
            }
        }

        switch (action) {
            case 'subscribe': {
                // `false` is the router's authz denial. No ack then — the
                // catalog is explicit that silence is how a refusal reads.
                const allowed = await this.router.subscribeToChannel(clientId, channel);
                if (allowed === false) return;
                this.router.sendToClient(clientId, {
                    type: 'subscribe',
                    action: 'subscribed',
                    channel,
                    timestamp: new Date().toISOString(),
                });
                return;
            }
            case 'unsubscribe': {
                await this.router.unsubscribeFromChannel(clientId, channel);
                this.router.sendToClient(clientId, {
                    type: 'subscribe',
                    action: 'unsubscribed',
                    channel,
                    timestamp: new Date().toISOString(),
                });
                return;
            }
            default:
                this.router.sendToClient(clientId, {
                    type: 'error',
                    service: 'subscribe',
                    code: 'UNKNOWN_ACTION',
                    message: `Unknown subscribe action: ${action}`,
                    timestamp: new Date().toISOString(),
                });
        }
    }
}

/** Build the service over a full RealtimeRouter. */
export function createSubscribeService(router: RealtimeRouter, opts?: SubscribeServiceOptions): SubscribeService {
    return new SubscribeService(router as unknown as SubscribeRouter, opts);
}
