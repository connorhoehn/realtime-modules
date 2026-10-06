import { type AuthorityScope } from '../server-ws/authorityScope';
import { type ChannelAccessRouter } from '../server-ws/channelAccess';
export declare const WORK_GRAPH_SERVICE = "work-graph";
/** The person-day a subscription reads. The viewer is the socket's identity. */
export interface WorkGraphStreamScope {
    personId: string;
    day: string;
    timezone: string;
}
/** Forwarded verbatim from the subscribe frame (schemaVersion 2 readers). */
export interface WorkGraphStreamActivityRequest {
    schemaVersion: 2;
    windowStart: string;
    windowEnd: string;
    mode: 'live' | 'as-of';
    viewBase?: 1;
}
/** What `channelFor` is told. */
export interface WorkGraphChannelContext {
    clientId: string;
    /** The socket's authenticated context (`router.getClientData(id).userContext`). */
    userContext: Record<string, unknown> | null;
    /** True for an `awaitAccess` placeholder (the reader holds no snapshot). */
    awaitAccess: boolean;
}
/** One live subscription, as the source sees it. Read-only to the host. */
export interface WorkGraphStreamSubscription {
    readonly clientId: string;
    readonly userContext: Record<string, unknown> | null;
    /** The router channel `channelFor` mapped this subscription to. */
    readonly channel: string;
    readonly scope: Readonly<WorkGraphStreamScope>;
    readonly subscriptionGeneration: string;
    /** The cursor of the last delta delivered (initially the snapshot's). */
    readonly cursor: string;
    readonly activity?: Readonly<WorkGraphStreamActivityRequest>;
    readonly viewPatch?: 1;
    readonly baseViewHash?: string;
}
export type WorkGraphStreamTrigger = {
    reason: 'subscribe';
} | {
    reason: 'change';
    change: unknown;
};
/**
 * The host's authorized view of the graph. `frames` answers, for ONE
 * subscriber, the stream messages it should receive now: deltas from
 * `sub.cursor` (filtered for that viewer), an `activity` refresh, or a
 * `reset-required` / `invalidate` when the cursor cannot be continued or
 * access changed. Return `[]` for nothing. Every message must carry the
 * subscription's generation (a delta in `batch.subscriptionGeneration`);
 * others are dropped. A throw sends `reset-required: source-unavailable`
 * and ends the subscription (the reader refetches with backoff).
 *
 * The source runs inside the publish operation's AuthorityScope (`scope`):
 * its own authorization reads may share it under the same revocability
 * contract as `authorize`.
 */
export interface WorkGraphSource {
    frames(sub: WorkGraphStreamSubscription, trigger: WorkGraphStreamTrigger, opts: {
        scope: AuthorityScope;
    }): readonly unknown[] | Promise<readonly unknown[]>;
}
export interface WorkGraphStreamConfig {
    /** Map a subscription to its router channel. Absent or null → refused. */
    channelFor?: (scope: WorkGraphStreamScope, ctx: WorkGraphChannelContext) => string | null | undefined | Promise<string | null | undefined>;
    /** The host's per-viewer frame source. Absent → only `awaitAccess` placeholders are accepted. */
    source?: WorkGraphSource;
    /**
     * Accept subscriptions on a router with no channel `authorize`. Off by
     * default: a person's work graph is never streamed through a router that
     * cannot refuse.
     */
    allowUnenforcedRouter?: boolean;
    /** Live subscriptions + placeholders per connection. Default 8. */
    maxSubscriptionsPerClient?: number;
    /** Largest router channel `channelFor` may return. Default 256. */
    maxChannelLength?: number;
}
export interface WorkGraphStreamLogger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
/** The router slice the service uses. `RealtimeRouter` satisfies it. */
export interface WorkGraphStreamRouter extends ChannelAccessRouter {
    sendToClient(clientId: string, message: unknown): void | boolean | Promise<void | boolean>;
    unsubscribeFromChannel?(clientId: string, channel: string): void | Promise<void>;
    isClientSubscribed?(clientId: string, channel: string, opts?: {
        scope?: AuthorityScope;
    }): boolean | Promise<boolean>;
    getClientData?(clientId: string): {
        userContext?: Record<string, unknown>;
    } | null | undefined;
}
export interface WorkGraphStreamServiceOptions {
    messageRouter: WorkGraphStreamRouter;
    logger?: WorkGraphStreamLogger;
    config?: WorkGraphStreamConfig;
}
/**
 * WS service behind the `workGraph()` feature. Construct it directly for a
 * custom transport; `attachRealtime` wires it as `services['work-graph']`.
 */
export declare class WorkGraphStreamService {
    private readonly router;
    private readonly logger;
    private readonly channelFor;
    private readonly source;
    private readonly allowUnenforcedRouter;
    private readonly maxSubscriptionsPerClient;
    private readonly maxChannelLength;
    /** clientId → generation → subscription (live and awaiting). */
    private readonly byClient;
    /** router channel → subscriptions on it. */
    private readonly byChannel;
    constructor(opts: WorkGraphStreamServiceOptions);
    handleAction(clientId: string, action: string, data: Record<string, unknown>): Promise<void>;
    onClientDisconnect(clientId: string): Promise<void>;
    /**
     * Something on `channel` changed. Every subscriber's frames are computed
     * by the source from that subscriber's own cursor and delivered after the
     * router confirms readability. Resolves when every delivery has settled.
     * The `change` is handed to the source and never sent to a client.
     */
    publish(channel: string, change?: unknown): Promise<{
        delivered: number;
    }>;
    /**
     * The host's access signal for `channel` (a grant created or resumed).
     * Each `awaitAccess` placeholder there that the router NOW admits gets a
     * content-free `reset-required: access-restored` and is dropped; the
     * reader refetches its snapshot, which is where data is authorized.
     */
    signalAccess(channel: string): Promise<{
        restored: number;
    }>;
    getStats(): {
        clients: number;
        subscriptions: number;
        awaiting: number;
        channels: number;
    };
    private handleSubscribe;
    private handleUnsubscribe;
    private enqueue;
    /** One delivery for one subscriber. True when at least one frame was sent. */
    private step;
    private readable;
    /** Access lost: a content-free invalidate, then the stream ends. */
    private revoke;
    private deliver;
    /** Stop a subscription, optionally sending one last stream message. */
    private end;
    private forget;
    /** Drop the router subscription unless another live generation of this client still uses it. */
    private releaseRoute;
    private index;
    private current;
    private view;
    private mapChannel;
    private contextOf;
    private frame;
    private refuse;
}
//# sourceMappingURL=streamService.d.ts.map