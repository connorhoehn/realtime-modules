"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWorkGraphGatewayTransport = createWorkGraphGatewayTransport;
/**
 * A `WorkGraphClientTransport` over the realtime socket, speaking the
 * `workGraph()` server feature's protocol (0.108). The hook is unchanged: it
 * still fetches its snapshot first, then opens the stream from the snapshot's
 * cursor; stream messages are handed to it verbatim.
 *
 * A dropped or replaced socket (a new `session` frame) and a subscribe
 * refusal end the stream through `onClose` / `onError`,
 * so the hook recovers through a fresh snapshot. `close()` unsubscribes.
 */
function createWorkGraphGatewayTransport(options) {
    const service = options.service ?? 'work-graph';
    return {
        fetchSnapshot: (request) => options.fetchSnapshot(request),
        openWebSocket(request) {
            if (options.isConnected && !options.isConnected())
                throw new Error('work-graph stream: socket not connected');
            const generation = request.subscriptionGeneration;
            let open = true;
            let stop = null;
            const finish = (terminal) => {
                if (!open)
                    return;
                open = false;
                stop?.();
                stop = null;
                terminal();
            };
            stop = options.gateway.onMessage((frame) => {
                if (!open || !frame || typeof frame !== 'object')
                    return;
                // A new session is a new connection: the server forgot this stream.
                if (frame.type === 'session') {
                    finish(() => request.onClose());
                    return;
                }
                if (frame.subscriptionGeneration !== generation)
                    return;
                if (frame.type === 'error' && frame.service === service) {
                    finish(() => request.onError());
                    return;
                }
                if (frame.type !== service)
                    return;
                if (frame.action === 'message')
                    request.onMessage(frame.message);
            });
            options.gateway.send({
                service,
                action: 'subscribe',
                subscriptionGeneration: generation,
                scope: { personId: request.scope.personId, day: request.scope.day, timezone: request.scope.timezone },
                ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
                ...(request.awaitAccess ? { awaitAccess: 1 } : {}),
                ...(request.activity ? { activity: request.activity } : {}),
                ...(request.viewPatch ? { viewPatch: 1 } : {}),
                ...(request.baseViewHash ? { baseViewHash: request.baseViewHash } : {}),
            });
            return {
                close() {
                    if (!open)
                        return;
                    open = false;
                    stop?.();
                    stop = null;
                    try {
                        options.gateway.send({ service, action: 'unsubscribe', subscriptionGeneration: generation });
                    }
                    catch { /* socket gone */ }
                },
            };
        },
    };
}
//# sourceMappingURL=gatewayTransport.js.map