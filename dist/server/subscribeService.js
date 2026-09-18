"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubscribeService = void 0;
exports.createSubscribeService = createSubscribeService;
class SubscribeService {
    router;
    constructor(router) {
        this.router = router;
    }
    async handleAction(clientId, action, data) {
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
        switch (action) {
            case 'subscribe': {
                // `false` is the router's authz denial. No ack then — the
                // catalog is explicit that silence is how a refusal reads.
                const allowed = await this.router.subscribeToChannel(clientId, channel);
                if (allowed === false)
                    return;
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
exports.SubscribeService = SubscribeService;
/** Build the service over a full RealtimeRouter. */
function createSubscribeService(router) {
    return new SubscribeService(router);
}
//# sourceMappingURL=subscribeService.js.map