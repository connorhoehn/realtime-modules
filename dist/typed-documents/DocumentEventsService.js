"use strict";
// realtime-modules/src/typed-documents/DocumentEventsService.ts
//
// Lifted from gateway's src/realtime-fanout/document-events-service.ts
// (132 LOC, Wave 2 extraction). WS-side surface only: subscription
// tracking + subscribe/unsubscribe action handlers + disconnect cleanup.
// No DDB, no Redis publish, no validation engine, no bulk-import.
//
// Lift changes vs the gateway original:
//   - Constructor switched from positional
//     `(messageRouter, logger, metricsCollector)` to a single
//     `DocumentEventsServiceOptions` bag so callers can wire optional
//     config (custom documentId length cap, future metrics) without an
//     ever-growing signature.
//   - `SubscriptionTracker` lifted inline (~30 LOC) so the module stays
//     dependency-free — matches the pattern used by the lifted
//     ReactionService.
//   - Hard-coded `documentId.length > 100` cap is now configurable via
//     `DocumentEventsConfig.maxDocumentIdLength` (default 100). The
//     error-message templating still embeds the cap so the wire surface
//     stays compatible.
//
// Everything else (action dispatch, channel naming
// `doc-comments:{id}` + `doc:{id}`, frame shape, error envelope,
// per-client tracker, getStats) is byte-faithful to the original.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentEventsService = void 0;
const DEFAULT_MAX_DOCUMENT_ID_LENGTH = 100;
/**
 * In-memory subscription tracker — `clientId → Set<channelId>`.
 *
 * Lifted from gateway's src/utils/subscription-tracker.ts (Wave 2).
 * Only the surface DocumentEventsService actually uses is implemented:
 * addSubscription, removeSubscription, removeClient, plus the Map's
 * has/get/set/delete/size to keep getStats() shape compatible.
 */
class SubscriptionTracker extends Map {
    addSubscription(clientId, channel) {
        let set = this.get(clientId);
        if (!set) {
            set = new Set();
            this.set(clientId, set);
        }
        set.add(channel);
    }
    removeSubscription(clientId, channel) {
        const set = this.get(clientId);
        if (!set)
            return false;
        const had = set.delete(channel);
        if (set.size === 0) {
            this.delete(clientId);
        }
        return had;
    }
    removeClient(clientId) {
        const set = this.get(clientId);
        if (!set)
            return [];
        const channels = Array.from(set);
        this.delete(clientId);
        return channels;
    }
    getStats() {
        let total = 0;
        for (const set of this.values()) {
            total += set.size;
        }
        return {
            subscribedClients: this.size,
            totalSubscriptions: total,
        };
    }
}
/**
 * DocumentEventsService — handles WebSocket subscriptions for real-time
 * document events.
 *
 * Clients send `{ service: 'document-events', action: 'subscribe',
 * documentId: '<id>' }` to begin receiving document events (comments,
 * reviews, items, workflows) broadcast by upstream publishers via the
 * channels `doc-comments:{documentId}` and `doc:{documentId}`.
 *
 * This service ONLY manages subscriptions. Publishing is the consumer
 * application's responsibility — gateway / social-api publish directly
 * to those channels.
 */
class DocumentEventsService {
    messageRouter;
    logger;
    metricsCollector;
    clientChannels;
    maxDocumentIdLength;
    constructor(opts) {
        if (!opts || !opts.logger) {
            throw new Error('DocumentEventsService: logger is required');
        }
        this.messageRouter = opts.messageRouter ?? null;
        this.logger = opts.logger;
        this.metricsCollector = opts.metricsCollector ?? null;
        const config = opts.config ?? {};
        this.maxDocumentIdLength = config.maxDocumentIdLength ?? DEFAULT_MAX_DOCUMENT_ID_LENGTH;
        this.clientChannels = new SubscriptionTracker();
    }
    async handleAction(clientId, action, data) {
        try {
            switch (action) {
                case 'subscribe':
                    return await this.handleSubscribe(clientId, data);
                case 'unsubscribe':
                    return await this.handleUnsubscribe(clientId, data);
                default:
                    this.sendError(clientId, `Unknown document-events action: ${action}`);
            }
        }
        catch (error) {
            this.logger.error(`Error handling document-events action ${action} for client ${clientId}:`, error);
            this.sendError(clientId, 'Internal server error');
        }
    }
    async handleSubscribe(clientId, { documentId }) {
        if (!documentId ||
            typeof documentId !== 'string' ||
            documentId.length === 0 ||
            documentId.length > this.maxDocumentIdLength) {
            this.sendError(clientId, `documentId is required (string, max ${this.maxDocumentIdLength} chars)`);
            return;
        }
        const channels = [`doc-comments:${documentId}`, `doc:${documentId}`];
        if (this.messageRouter) {
            for (const channel of channels) {
                await this.messageRouter.subscribeToChannel(clientId, channel);
            }
        }
        for (const channel of channels) {
            this.clientChannels.addSubscription(clientId, channel);
        }
        this.sendToClient(clientId, {
            type: 'document-events',
            action: 'subscribed',
            documentId,
            timestamp: new Date().toISOString(),
        });
        this.logger.info(`Client ${clientId} subscribed to document events for ${documentId}`);
    }
    async handleUnsubscribe(clientId, { documentId }) {
        if (!documentId) {
            this.sendError(clientId, 'documentId is required');
            return;
        }
        const channels = [`doc-comments:${documentId}`, `doc:${documentId}`];
        for (const channel of channels) {
            if (this.messageRouter) {
                await this.messageRouter.unsubscribeFromChannel(clientId, channel);
            }
            this.clientChannels.removeSubscription(clientId, channel);
        }
        this.sendToClient(clientId, {
            type: 'document-events',
            action: 'unsubscribed',
            documentId,
            timestamp: new Date().toISOString(),
        });
        this.logger.info(`Client ${clientId} unsubscribed from document events for ${documentId}`);
    }
    async handleDisconnect(clientId) {
        const channels = this.clientChannels.removeClient(clientId);
        for (const channelId of channels) {
            try {
                if (this.messageRouter) {
                    await this.messageRouter.unsubscribeFromChannel(clientId, channelId);
                }
            }
            catch (error) {
                this.logger.error(`Error unsubscribing client ${clientId} from document-events channel ${channelId}:`, error);
            }
        }
        this.logger.debug(`Client ${clientId} disconnected from document-events service`);
    }
    sendToClient(clientId, message) {
        if (this.messageRouter) {
            this.messageRouter.sendToClient(clientId, message);
        }
    }
    sendError(clientId, message) {
        this.sendToClient(clientId, {
            type: 'error',
            service: 'document-events',
            message,
            timestamp: new Date().toISOString(),
        });
    }
    getStats() {
        return this.clientChannels.getStats();
    }
}
exports.DocumentEventsService = DocumentEventsService;
exports.default = DocumentEventsService;
//# sourceMappingURL=DocumentEventsService.js.map