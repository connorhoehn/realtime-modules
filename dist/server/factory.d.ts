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
 * Alternate adapter configuration form that groups adapters by feature.
 * Use this when you only want to override adapters for specific features
 * and leave others at their defaults.
 *
 * @example
 * createRealtimeServer([ChatManifest], {
 *   chat: { store: myRedisChatStore },
 * }, { server: httpServer });
 */
export interface PerFeatureAdapters {
    /** Adapters for the chat feature. */
    chat?: {
        /** Backing store for persisted chat messages. */
        store?: ChatStore;
    };
    /** Adapters for the activity feature. */
    activity?: {
        /** Backing store for activity-feed history. */
        historyStore?: ActivityHistoryStore;
    };
}
/**
 * Either a flat `AdapterMap` (legacy / `inMemoryAdapters()` form) or a
 * per-feature `PerFeatureAdapters` object.
 *
 * At runtime the factory normalises both into an `AdapterMap` before
 * passing to service factories — so existing callers are unaffected.
 */
export type AdapterConfig = AdapterMap | PerFeatureAdapters;
/**
 * Lifecycle hook interface. Implement any subset of hooks; the router calls
 * each registered plugin in array order. All calls are fire-and-forget —
 * errors are logged with `console.error` but never propagate to callers.
 */
export interface FeaturePlugin {
    /** Optional name for logging / debugging. */
    name?: string;
    /** Called when a client subscribes to a channel. */
    onConnect?(ctx: {
        clientId: string;
        channelId: string;
    }): void | Promise<void>;
    /**
     * Called when a client disconnects (unsubscribes from all channels).
     * `channels` is the full list of channels the client was in.
     */
    onDisconnect?(ctx: {
        clientId: string;
        channels: string[];
    }): void | Promise<void>;
    /**
     * Called before a message is fanned out to a channel.
     * `clientId` is the sender; if the send originates from the server
     * (no excludeClientId) it is set to `'server'`.
     */
    onMessage?(ctx: {
        clientId: string;
        channelId: string;
        message: unknown;
    }): void | Promise<void>;
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
export interface RealtimeServerOptions extends Omit<WsHandlerOptions, 'services'> {
    /**
     * Optional lifecycle plugins. Each plugin's hooks are called in array
     * order. Calls are fire-and-forget — errors are logged but never
     * propagate to the caller.
     */
    plugins?: FeaturePlugin[];
}
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
 * @param adapters  Storage backends. Either a flat `AdapterMap` (or the result
 *                  of `inMemoryAdapters()`) or a `PerFeatureAdapters` object.
 *                  Pass `inMemoryAdapters()` for dev/tests, or provide real
 *                  implementations for production.
 * @param opts      WsHandlerOptions (minus `services`). `server` is required.
 *                  Optionally include `plugins` for lifecycle hooks.
 */
export declare function createRealtimeServer(features: FeatureManifest[], adapters: AdapterConfig | undefined, opts: RealtimeServerOptions): WsHandlerHandle;
//# sourceMappingURL=factory.d.ts.map