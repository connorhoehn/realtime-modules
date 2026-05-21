import { type DocumentEventsLogger, type DocumentEventsMessageRouter, type DocumentEventsMetricsCollector, type DocumentEventsServiceOptions } from './types';
/**
 * In-memory subscription tracker — `clientId → Set<channelId>`.
 *
 * Lifted from gateway's src/utils/subscription-tracker.ts (Wave 2).
 * Only the surface DocumentEventsService actually uses is implemented:
 * addSubscription, removeSubscription, removeClient, plus the Map's
 * has/get/set/delete/size to keep getStats() shape compatible.
 */
declare class SubscriptionTracker extends Map<string, Set<string>> {
    addSubscription(clientId: string, channel: string): void;
    removeSubscription(clientId: string, channel: string): boolean;
    removeClient(clientId: string): string[];
    getStats(): {
        subscribedClients: number;
        totalSubscriptions: number;
    };
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
export declare class DocumentEventsService {
    messageRouter: DocumentEventsMessageRouter | null;
    logger: DocumentEventsLogger;
    metricsCollector: DocumentEventsMetricsCollector | null;
    clientChannels: SubscriptionTracker;
    maxDocumentIdLength: number;
    constructor(opts: DocumentEventsServiceOptions);
    handleAction(clientId: string, action: string, data: any): Promise<void>;
    handleSubscribe(clientId: string, { documentId }: {
        documentId: string;
    }): Promise<void>;
    handleUnsubscribe(clientId: string, { documentId }: {
        documentId: string;
    }): Promise<void>;
    handleDisconnect(clientId: string): Promise<void>;
    sendToClient(clientId: string, message: unknown): void;
    sendError(clientId: string, message: string): void;
    getStats(): {
        subscribedClients: number;
        totalSubscriptions: number;
    };
}
export default DocumentEventsService;
//# sourceMappingURL=DocumentEventsService.d.ts.map