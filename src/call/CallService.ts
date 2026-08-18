// realtime-modules/src/call/CallService.ts
//
// Lifted from gateway's src/services/call-service.ts (Wave 2 catch-up).
// SCOPE: hangout/call **invite signaling** only — the 5-event lifecycle
// (invite/accepted/declined/cancelled/ended) fanned out user-to-user
// over the existing WS connection. NO WebRTC, NO SDP, NO ICE, NO SFU
// media-plane code. The media plane lives in live-video-streaming +
// platform-api's useVideoCall path; this module is signaling only.
//
// Routing modes (both preserved byte-faithfully from the gateway original):
//
//   1. Broadcast (empty/missing targetUserIds) — fans out to every
//      connected client except the sender. Backs the original "📞 Hangout"
//      button: every other tab/session sees the banner and can opt in.
//      Sender is excluded so the initiator's own WebSocket doesn't echo;
//      OTHER tabs of the initiator still receive and filter by callerId
//      on the FE.
//
//   2. Targeted (targetUserIds populated) — delivers to every connected
//      client whose authenticated userId is in `targetUserIds`. Backs
//      both the per-row "📞" button (1-element array = 1:1 call) and the
//      multi-select group-call CTA (N-element array). Sender is still
//      excluded by passing the senderClientId through to the resolver.
//
// Legacy single-target field `targetUserId` is still accepted on the
// wire and coerced into a 1-element `targetUserIds` array — the decline
// back-route finds it more natural.
//
// Lift changes vs the gateway original:
//   - Constructor switched from positional (router, logger, metrics) to
//     a single CallServiceOptions bag.
//   - enforceChannelPermission interceptor coupling replaced with a
//     pluggable `authorize` hook (defaults to allow-all). Call routing
//     is direct user-to-user so there's no channel to gate.
//   - ErrorCodes / createErrorResponse import removed; CallErrorFrame
//     is the inlined minimal shape.
//   - The lazy-required `../observability/metrics` prom counter is gone;
//     consumers pass a `recordCallAction` callback through CallConfig.
//   - MetricsCollector positional arg dropped — wire the callback above
//     to whatever sink the consumer already has (prom/CloudWatch/…).

import {
    ALLOWED_CALL_ACTIONS,
    type CallAction,
    type CallConfig,
    type CallErrorFrame,
    type CallEvent,
    type CallInvite,
    type CallLogger,
    type CallMessageRouter,
    type CallServiceOptions,
} from './types';

export class CallService {
    messageRouter: CallMessageRouter;
    logger: CallLogger;

    private authorize: (clientId: string, action: CallAction, data: CallInvite) => boolean;
    private recordCallActionHook: ((action: CallAction, targetKind: 'targeted' | 'broadcast') => void) | null;

    constructor(opts: CallServiceOptions) {
        if (!opts || !opts.messageRouter) {
            throw new Error('CallService: messageRouter is required');
        }
        if (!opts.logger) {
            throw new Error('CallService: logger is required');
        }
        this.messageRouter = opts.messageRouter;
        this.logger = opts.logger;

        const config: CallConfig = opts.config ?? {};
        this.authorize = config.authorize ?? (() => true);
        this.recordCallActionHook = config.recordCallAction ?? null;
    }

    async handleAction(clientId: string, action: string, data: CallInvite | null | undefined): Promise<void> {
        try {
            if (!ALLOWED_CALL_ACTIONS.has(action as CallAction)) {
                this.sendError(clientId, `Unknown call action: ${action}`);
                return;
            }
            const typedAction = action as CallAction;
            if (!this.authorize(clientId, typedAction, data ?? {})) {
                this.sendError(clientId, `Not authorized for call action: ${typedAction}`);
                return;
            }
            return await this.handleCallEvent(clientId, typedAction, data);
        } catch (error: any) {
            this.logger.error(`Error handling call action ${action} for client ${clientId}:`, error);
            this.sendError(clientId, 'Internal server error');
        }
    }

    async handleCallEvent(
        clientId: string,
        action: CallAction,
        data: CallInvite | null | undefined,
    ): Promise<void> {
        const payload: CallInvite = data ?? {};
        const callId = payload.callId;
        const lobbyName = payload.lobbyName;

        // Normalize routing targets — accept either `targetUserIds: string[]`
        // (preferred) or legacy `targetUserId: string`. Empty/missing = broadcast.
        const targetUserIds = this.normalizeTargetUserIds(payload);

        if (action === 'invite' && (!callId || !lobbyName)) {
            this.sendError(clientId, 'callId and lobbyName are required on invite');
            return;
        }

        const envelope: CallEvent = {
            type: 'call',
            action,
            data: payload,
            timestamp: new Date().toISOString(),
        };

        if (targetUserIds.length > 0) {
            const recipients = this.findClientsForUsers(targetUserIds, /* excludeClientId */ clientId);
            const planned = recipients.length;

            // Promise.allSettled — never short-circuit on a single send failure.
            // sendToClient itself returns false on a closed socket and may throw
            // (sync OR async) when the publish path errors; either way we count
            // this as a delivery failure and keep going. The wrapper converts a
            // synchronous throw into a rejected promise so allSettled can
            // observe it without aborting the whole map.
            const results = await Promise.allSettled(
                recipients.map((targetClientId: string) => {
                    try {
                        return Promise.resolve(this.messageRouter.sendToClient(targetClientId, envelope));
                    } catch (err) {
                        return Promise.reject(err);
                    }
                }),
            );

            let delivered = 0;
            const failures: Array<{ targetClientId: string; reason: string }> = [];
            results.forEach((result, idx) => {
                const targetClientId = recipients[idx];
                if (result.status === 'fulfilled' && result.value !== false) {
                    delivered += 1;
                } else {
                    const reason =
                        result.status === 'rejected'
                            ? (result.reason && result.reason.message) || String(result.reason)
                            : 'sendToClient returned false';
                    failures.push({ targetClientId, reason });
                }
            });

            if (failures.length > 0) {
                this.logger.warn(
                    `Client ${clientId} call event '${action}': ${delivered}/${planned} delivered ` +
                        `(callId=${callId ?? '-'} lobby=${lobbyName ?? '-'})`,
                    { failures },
                );
            } else {
                this.logger.info(
                    `Client ${clientId} sent call event '${action}' to users [${targetUserIds.join(', ')}] ` +
                        `(callId=${callId ?? '-'} lobby=${lobbyName ?? '-'} delivered=${delivered}/${planned})`,
                );
            }

            this.recordCallActionMetric(action, 'targeted');
            return;
        }

        // Broadcast path — everyone except the sender.
        await this.messageRouter.broadcastToAll(envelope, clientId);
        this.logger.info(
            `Client ${clientId} broadcast call event '${action}' (callId=${callId ?? '-'} lobby=${lobbyName ?? '-'})`,
        );
        this.recordCallActionMetric(action, 'broadcast');
    }

    /**
     * Pull the target user-id list out of a call payload, accepting either
     * the array form (`targetUserIds: string[]`) or the legacy single-target
     * shape (`targetUserId: string`). Returns a deduped array — empty means
     * the call should be broadcast.
     */
    normalizeTargetUserIds(payload: CallInvite): string[] {
        const out = new Set<string>();
        if (Array.isArray(payload.targetUserIds)) {
            for (const id of payload.targetUserIds) {
                if (typeof id === 'string' && id.length) out.add(id);
            }
        }
        if (typeof payload.targetUserId === 'string' && payload.targetUserId.length) {
            out.add(payload.targetUserId);
        }
        return Array.from(out);
    }

    /**
     * Return the clientIds of every connected client authenticated as any of
     * the provided userIds, excluding the sender. Delegates to MessageRouter's
     * `getClientsByUserId` seam — that method is the single chokepoint that
     * the cross-replica resolver swaps for a Redis-backed implementation.
     */
    findClientsForUsers(userIds: string[], excludeClientId: string): string[] {
        if (!this.messageRouter || typeof this.messageRouter.getClientsByUserId !== 'function') {
            return [];
        }
        const matches = this.messageRouter.getClientsByUserId(userIds, excludeClientId);
        // Return the legacy `string[]` shape (clientIds only) — this is the
        // contract every existing call site expects.
        return matches.map((m) => m.clientId);
    }

    /**
     * Fire the optional recordCallAction hook. Wrapped in try/catch so a
     * misbehaving consumer sink can never break call routing.
     */
    recordCallActionMetric(action: CallAction, targetKind: 'targeted' | 'broadcast'): void {
        if (!this.recordCallActionHook) return;
        try {
            this.recordCallActionHook(action, targetKind);
        } catch (_e) {
            /* metrics are optional — fail open */
        }
    }

    async handleDisconnect(_clientId: string): Promise<void> {
        // Stateless — no per-client subscriptions to tear down.
    }

    sendError(clientId: string, message: string): void {
        if (!this.messageRouter) return;
        const frame: CallErrorFrame = {
            type: 'error',
            service: 'call',
            message,
            timestamp: new Date().toISOString(),
        };
        this.messageRouter.sendToClient(clientId, frame);
    }

    getStats(): { stateful: false } {
        return { stateful: false };
    }
}

export default CallService;
