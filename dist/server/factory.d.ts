import type { FeatureManifest } from '../feature-manifest/types';
import type { WsHandlerHandle, WsHandlerOptions } from '../server-ws/types';
import { type ChatStore } from '../chat/ChatStore';
import { type ActivityHistoryStore } from '../activity/ActivityHistoryStore';
/**
 * All pluggable backends a feature might need. Pass real implementations for
 * production; call `inMemoryAdapters()` for zero-config dev / testing.
 *
 * All fields are optional — `inMemoryAdapters()` fills every one with an
 * in-memory fallback, and individual service factories fall back to their
 * own built-in in-memory defaults when a field is absent.
 */
export interface AdapterMap {
    /**
     * Backing store for persisted chat messages. When absent, ChatService
     * falls back to its built-in InMemoryChatStore.
     */
    chatStore?: ChatStore;
    /**
     * Backing store for activity-feed history. When absent, ActivityService
     * falls back to its built-in InMemoryActivityHistoryStore.
     */
    activityHistoryStore?: ActivityHistoryStore;
}
/**
 * Returns an `AdapterMap` backed entirely by in-process Maps — no external
 * services (Redis, DynamoDB) required.
 *
 * Intended for:
 *   - local development without docker-compose
 *   - unit / integration tests
 *   - embedded apps that don't need durable storage
 */
export declare function inMemoryAdapters(): AdapterMap;
/**
 * Options for createRealtimeServer. Merges WsHandlerOptions (minus `services`,
 * which the factory builds from `features`) with feature/adapter config.
 */
export type RealtimeServerOptions = Omit<WsHandlerOptions, 'services'>;
/**
 * Wire `features` + `adapters` into a ready-to-use WS handler.
 *
 * Returns the same `WsHandlerHandle` shape that `createWsHandler` returns:
 *   { wss, dispose(), listClients(), sendToClient() }
 *
 * Minimal example (10 lines):
 *
 *   const httpServer = http.createServer(app);
 *   const handle = createRealtimeServer(
 *     [ChatManifest, PresenceManifest],
 *     inMemoryAdapters(),
 *     { server: httpServer },
 *   );
 *   httpServer.listen(3000);
 *
 * @param features  Array of FeatureManifest objects — only manifests whose
 *                  `name` appears in the built-in registry are instantiated.
 *                  Unknown names are silently skipped.
 * @param adapters  Storage backends. Pass `inMemoryAdapters()` for dev/tests,
 *                  or provide real implementations for production.
 * @param opts      WsHandlerOptions (minus `services`). `server` is required.
 */
export declare function createRealtimeServer(features: FeatureManifest[], adapters: Partial<AdapterMap> | undefined, opts: RealtimeServerOptions): WsHandlerHandle;
//# sourceMappingURL=factory.d.ts.map