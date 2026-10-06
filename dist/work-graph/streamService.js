"use strict";
// realtime-modules/src/work-graph/streamService.ts
//
// The server half of `useWorkGraph`'s stream (0.108). The client hook fetches
// an authorized snapshot, then opens a stream from that snapshot's cursor and
// applies `delta` / `activity` / `invalidate` / `reset-required` messages.
// Until now the library shipped only the client half, so a host had to fake
// `openWebSocket` and push content-free hints. This service is the stream:
//
//   - Channels are TENANT-MAPPABLE and DEFAULT-DENY. Each subscription's
//     `{ personId, day, timezone }` is mapped by the host's `channelFor` to a
//     router channel (`acme:work-graph:p-001:2026-10-06`). No `channelFor`, or
//     `channelFor` answering null/throwing, refuses the subscription. There is
//     no firehose: every subscription names one person-day.
//   - The ROUTER gates: the mapped channel is subscribed through
//     `router.subscribeToChannel` (so `authorize({ kind: 'subscribe' })`
//     judges it), and every delivery rechecks readability (the router's
//     `isClientSubscribed`, else a silent `checkChannel`) before AND after the
//     source computes the frames. A router that cannot refuse anything (no
//     `authorize` configured) is refused unless `allowUnenforcedRouter`.
//   - SERVER-PUBLISH ONLY. Clients subscribe/unsubscribe; they never publish.
//     The host calls `publish(channel, change)` when something on that
//     person-day changed. The change itself is never sent to anyone: for
//     each subscriber the host's `WorkGraphSource.frames` computes that
//     viewer's frames from that subscription's own cursor, so every delta is
//     filtered for its reader (deltas carry a per-subscription generation,
//     watermark and cursor; one channel-wide frame could not be correct).
//   - SNAPSHOT-ON-SUBSCRIBE. A subscription opened from a snapshot cursor is
//     caught up immediately (`frames(sub, { reason: 'subscribe' })`), closing
//     the gap between the snapshot read and the stream opening.
//   - Revocation: one `publish` is one operation with one AuthorityScope
//     shared by every recipient check (one proof per channel). A host that
//     memoizes in the scope must keep proofs revocable (see AuthorityScope);
//     a recipient found unreadable gets a content-free
//     `invalidate: policy-changed` and its subscription ends.
//
// Frames on the wire (`service: 'work-graph'`):
//
//   client → { service, action: 'subscribe', subscriptionGeneration,
//              scope: { personId, day, timezone }, cursor?, awaitAccess?: 1,
//              activity?, viewPatch?: 1, baseViewHash? }
//   client → { service, action: 'unsubscribe', subscriptionGeneration }
//   server → { type: 'work-graph', action: 'subscribed' | 'awaiting', subscriptionGeneration }
//   server → { type: 'work-graph', action: 'message', subscriptionGeneration, message }
//   server → { type: 'error', service: 'work-graph', code: 'WORK_GRAPH_SUBSCRIBE_REFUSED',
//              subscriptionGeneration, message }
//
// `message` is exactly what `useWorkGraph` hands its reducer. A stream ends
// with its last message (`invalidate` / `reset-required`), after which the
// server holds nothing for that generation. The client
// helper `createWorkGraphGatewayTransport` (`/client`) speaks this protocol.
//
// Multi-node: subscriptions live on the node that holds the socket. Call
// `publish` / `signalAccess` on every replica (each replica consumes the
// host's change feed); a replica with no subscriber on the channel does
// nothing.
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkGraphStreamService = exports.WORK_GRAPH_SERVICE = void 0;
const authorityScope_1 = require("../server-ws/authorityScope");
const channelAccess_1 = require("../server-ws/channelAccess");
const contracts_1 = require("./contracts");
exports.WORK_GRAPH_SERVICE = 'work-graph';
const GENERATION = /^[A-Za-z0-9_.:-]{1,128}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX_SUBSCRIPTIONS = 8;
const DEFAULT_MAX_CHANNEL_LENGTH = 256;
const STREAM_KINDS = new Set(['delta', 'activity', 'invalidate', 'reset-required']);
const NOOP = { debug() { }, info() { }, warn() { }, error() { } };
function boundedString(value, max) {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function parseScope(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const { personId, day, timezone } = value;
    if (!boundedString(personId, contracts_1.WORK_GRAPH_LIMITS.idLength))
        return null;
    if (typeof day !== 'string' || !DAY.test(day))
        return null;
    if (!boundedString(timezone, contracts_1.WORK_GRAPH_LIMITS.timezoneLength))
        return null;
    return { personId, day, timezone };
}
function parseActivity(value) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const a = value;
    if (a.schemaVersion !== 2 || !boundedString(a.windowStart, 64) || !boundedString(a.windowEnd, 64)
        || (a.mode !== 'live' && a.mode !== 'as-of') || (a.viewBase !== undefined && a.viewBase !== 1))
        return null;
    return {
        schemaVersion: 2, windowStart: a.windowStart, windowEnd: a.windowEnd, mode: a.mode,
        ...(a.viewBase === 1 ? { viewBase: 1 } : {}),
    };
}
/** The generation a stream message names, or null when it names none. */
function messageGeneration(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message))
        return null;
    const m = message;
    if (typeof m.kind !== 'string' || !STREAM_KINDS.has(m.kind))
        return null;
    if (m.kind === 'delta') {
        const batch = m.batch;
        return batch && typeof batch === 'object' && typeof batch.subscriptionGeneration === 'string'
            ? batch.subscriptionGeneration : null;
    }
    return typeof m.subscriptionGeneration === 'string' ? m.subscriptionGeneration : null;
}
/**
 * WS service behind the `workGraph()` feature. Construct it directly for a
 * custom transport; `attachRealtime` wires it as `services['work-graph']`.
 */
class WorkGraphStreamService {
    router;
    logger;
    channelFor;
    source;
    allowUnenforcedRouter;
    maxSubscriptionsPerClient;
    maxChannelLength;
    /** clientId → generation → subscription (live and awaiting). */
    byClient = new Map();
    /** router channel → subscriptions on it. */
    byChannel = new Map();
    constructor(opts) {
        if (!opts?.messageRouter)
            throw new Error('WorkGraphStreamService: messageRouter is required');
        const config = opts.config ?? {};
        this.router = opts.messageRouter;
        this.logger = opts.logger ?? NOOP;
        this.channelFor = typeof config.channelFor === 'function' ? config.channelFor : null;
        this.source = config.source ?? null;
        this.allowUnenforcedRouter = config.allowUnenforcedRouter === true;
        this.maxSubscriptionsPerClient = config.maxSubscriptionsPerClient ?? DEFAULT_MAX_SUBSCRIPTIONS;
        this.maxChannelLength = config.maxChannelLength ?? DEFAULT_MAX_CHANNEL_LENGTH;
    }
    async handleAction(clientId, action, data) {
        try {
            if (action === 'subscribe')
                return await this.handleSubscribe(clientId, data ?? {});
            if (action === 'unsubscribe')
                return await this.handleUnsubscribe(clientId, data ?? {});
            this.refuse(clientId, typeof data?.subscriptionGeneration === 'string' ? data.subscriptionGeneration : null, `Unknown work-graph action: ${action}`, 'WORK_GRAPH_BAD_REQUEST');
        }
        catch (err) {
            this.logger.error(`[work-graph] ${action} failed for ${clientId}`, err);
        }
    }
    async onClientDisconnect(clientId) {
        const subs = this.byClient.get(clientId);
        if (!subs)
            return;
        for (const sub of [...subs.values()])
            this.forget(sub);
        this.byClient.delete(clientId);
    }
    /**
     * Something on `channel` changed. Every subscriber's frames are computed
     * by the source from that subscriber's own cursor and delivered after the
     * router confirms readability. Resolves when every delivery has settled.
     * The `change` is handed to the source and never sent to a client.
     */
    async publish(channel, change) {
        const subs = [...(this.byChannel.get(channel) ?? [])].filter(s => s.active && !s.awaiting);
        if (subs.length === 0)
            return { delivered: 0 };
        const scope = (0, authorityScope_1.createAuthorityScope)('work-graph.publish');
        try {
            const results = await Promise.all(subs.map(sub => this.enqueue(sub, scope, { reason: 'change', change })));
            return { delivered: results.filter(Boolean).length };
        }
        finally {
            scope.close();
        }
    }
    /**
     * The host's access signal for `channel` (a grant created or resumed).
     * Each `awaitAccess` placeholder there that the router NOW admits gets a
     * content-free `reset-required: access-restored` and is dropped; the
     * reader refetches its snapshot, which is where data is authorized.
     */
    async signalAccess(channel) {
        const waiting = [...(this.byChannel.get(channel) ?? [])].filter(s => s.active && s.awaiting);
        if (waiting.length === 0)
            return { restored: 0 };
        const scope = (0, authorityScope_1.createAuthorityScope)('work-graph.access');
        let restored = 0;
        try {
            await Promise.all(waiting.map(async (sub) => {
                const ok = await (0, channelAccess_1.routerPermits)(this.router, 'subscribe', sub.clientId, channel, { silent: true, scope });
                if (!ok || !this.current(sub))
                    return;
                this.forget(sub);
                this.deliver(sub, { kind: 'reset-required', subscriptionGeneration: sub.subscriptionGeneration, reason: 'access-restored' });
                restored++;
            }));
        }
        finally {
            scope.close();
        }
        return { restored };
    }
    getStats() {
        let subscriptions = 0, awaiting = 0;
        for (const subs of this.byClient.values())
            for (const s of subs.values())
                (s.awaiting ? awaiting++ : subscriptions++);
        return { clients: this.byClient.size, subscriptions, awaiting, channels: this.byChannel.size };
    }
    // ---- subscribe / unsubscribe -------------------------------------------
    async handleSubscribe(clientId, data) {
        const generation = data.subscriptionGeneration;
        if (typeof generation !== 'string' || !GENERATION.test(generation)) {
            this.refuse(clientId, null, 'subscriptionGeneration is required', 'WORK_GRAPH_BAD_REQUEST');
            return;
        }
        const scope = parseScope(data.scope);
        const awaiting = data.awaitAccess === 1;
        const cursor = data.cursor;
        const activity = parseActivity(data.activity);
        const baseViewHash = data.baseViewHash;
        if (!scope || activity === null
            || (data.viewPatch !== undefined && data.viewPatch !== 1)
            || (baseViewHash !== undefined && !boundedString(baseViewHash, 256))
            || (awaiting ? cursor !== undefined : !boundedString(cursor, contracts_1.WORK_GRAPH_LIMITS.cursorLength))) {
            this.refuse(clientId, generation, 'Invalid work-graph subscription', 'WORK_GRAPH_BAD_REQUEST');
            return;
        }
        // A reused generation replaces its predecessor on this connection.
        const existing = this.byClient.get(clientId)?.get(generation);
        if (existing)
            await this.end(existing);
        const held = this.byClient.get(clientId)?.size ?? 0;
        if (held >= this.maxSubscriptionsPerClient) {
            this.refuse(clientId, generation, 'Too many work-graph subscriptions', 'WORK_GRAPH_SUBSCRIBE_REFUSED');
            return;
        }
        if (!awaiting && !this.source) {
            this.refuse(clientId, generation, 'No work-graph source is configured', 'WORK_GRAPH_SUBSCRIBE_REFUSED');
            return;
        }
        if (!awaiting && !this.allowUnenforcedRouter && !(0, channelAccess_1.routerEnforcesChannelAccess)(this.router)) {
            this.refuse(clientId, generation, 'The router enforces no channel authorization', 'WORK_GRAPH_SUBSCRIBE_REFUSED');
            return;
        }
        const userContext = this.contextOf(clientId);
        const sub = {
            clientId, userContext, channel: '', scope, subscriptionGeneration: generation,
            cursor: awaiting ? '' : cursor,
            ...(activity ? { activity } : {}),
            ...(data.viewPatch === 1 ? { viewPatch: 1 } : {}),
            ...(typeof baseViewHash === 'string' ? { baseViewHash } : {}),
            active: true, awaiting, routed: false, queue: Promise.resolve(),
        };
        // Registered before any await so an unsubscribe/disconnect during
        // mapping or authorization cancels it.
        let subs = this.byClient.get(clientId);
        if (!subs) {
            subs = new Map();
            this.byClient.set(clientId, subs);
        }
        subs.set(generation, sub);
        const channel = await this.mapChannel(clientId, scope, userContext, awaiting);
        if (!this.current(sub))
            return;
        if (!channel) {
            this.forget(sub);
            this.refuse(clientId, generation, 'Not allowed to subscribe to this work graph', 'WORK_GRAPH_SUBSCRIBE_REFUSED');
            return;
        }
        sub.channel = channel;
        if (awaiting) {
            this.index(sub);
            this.frame(clientId, { type: 'work-graph', action: 'awaiting', subscriptionGeneration: generation });
            return;
        }
        const opts = { service: exports.WORK_GRAPH_SERVICE, clientChannel: channel };
        let admitted = false;
        try {
            admitted = typeof this.router.subscribeToChannel === 'function'
                ? (await this.router.subscribeToChannel(clientId, channel, opts)) !== false
                : await (0, channelAccess_1.routerPermits)(this.router, 'subscribe', clientId, channel, opts);
        }
        catch {
            admitted = false;
        }
        if (!this.current(sub)) {
            if (admitted)
                await this.releaseRoute(clientId, channel);
            return;
        }
        if (!admitted) {
            this.forget(sub);
            this.refuse(clientId, generation, 'Not allowed to subscribe to this work graph', 'WORK_GRAPH_SUBSCRIBE_REFUSED');
            return;
        }
        sub.routed = true;
        this.index(sub);
        this.frame(clientId, { type: 'work-graph', action: 'subscribed', subscriptionGeneration: generation });
        // Catch up from the snapshot's cursor: changes between the snapshot
        // read and this subscribe are not lost.
        const scopeForCatchUp = (0, authorityScope_1.createAuthorityScope)('work-graph.subscribe');
        try {
            await this.enqueue(sub, scopeForCatchUp, { reason: 'subscribe' });
        }
        finally {
            scopeForCatchUp.close();
        }
    }
    async handleUnsubscribe(clientId, data) {
        const generation = data.subscriptionGeneration;
        if (typeof generation !== 'string')
            return;
        const sub = this.byClient.get(clientId)?.get(generation);
        if (sub)
            await this.end(sub);
    }
    // ---- delivery --------------------------------------------------------
    enqueue(sub, scope, trigger) {
        const release = scope.retain();
        let delivered = false;
        const run = sub.queue.then(async () => {
            try {
                delivered = await this.step(sub, scope, trigger);
            }
            catch (err) {
                this.logger.error('[work-graph] delivery failed', err);
            }
            finally {
                release();
            }
        });
        sub.queue = run;
        return run.then(() => delivered);
    }
    /** One delivery for one subscriber. True when at least one frame was sent. */
    async step(sub, scope, trigger) {
        if (!this.current(sub) || !this.source)
            return false;
        if (!(await this.readable(sub, scope))) {
            if (this.current(sub))
                await this.revoke(sub);
            return false;
        }
        if (!this.current(sub))
            return false;
        let frames;
        try {
            frames = await this.source.frames(this.view(sub), trigger, { scope });
        }
        catch (err) {
            this.logger.warn('[work-graph] source failed; asking the reader to refetch', err);
            if (!this.current(sub))
                return false;
            await this.end(sub, { kind: 'reset-required', subscriptionGeneration: sub.subscriptionGeneration, reason: 'source-unavailable' });
            return false;
        }
        if (!this.current(sub) || !Array.isArray(frames) || frames.length === 0)
            return false;
        // Access may have changed while the source read: ask again (shared
        // within this operation; a revocation the host observed denies).
        if (!(await this.readable(sub, scope))) {
            if (this.current(sub))
                await this.revoke(sub);
            return false;
        }
        let sent = false;
        for (const message of frames) {
            if (!this.current(sub))
                break;
            if (messageGeneration(message) !== sub.subscriptionGeneration) {
                this.logger.warn('[work-graph] source frame dropped: wrong or missing subscriptionGeneration');
                continue;
            }
            const kind = message.kind;
            if (kind === 'invalidate' || kind === 'reset-required') {
                // The stream ends here: the reader recovers with a new generation.
                await this.end(sub, message);
                return true;
            }
            if (kind === 'delta') {
                const cursor = (message.batch).cursor;
                if (boundedString(cursor, contracts_1.WORK_GRAPH_LIMITS.cursorLength))
                    sub.cursor = cursor;
            }
            this.deliver(sub, message);
            sent = true;
        }
        return sent;
    }
    async readable(sub, scope) {
        if (this.contextOf(sub.clientId) !== sub.userContext)
            return false;
        try {
            const ok = typeof this.router.isClientSubscribed === 'function'
                ? await this.router.isClientSubscribed(sub.clientId, sub.channel, { scope })
                : await (0, channelAccess_1.routerPermits)(this.router, 'subscribe', sub.clientId, sub.channel, { silent: true, scope });
            return ok === true && this.contextOf(sub.clientId) === sub.userContext;
        }
        catch {
            return false;
        }
    }
    /** Access lost: a content-free invalidate, then the stream ends. */
    revoke(sub) {
        // A replaced connection identity gets nothing at all.
        if (this.contextOf(sub.clientId) !== sub.userContext)
            return this.end(sub);
        return this.end(sub, { kind: 'invalidate', subscriptionGeneration: sub.subscriptionGeneration, reason: 'policy-changed' });
    }
    deliver(sub, message) {
        this.frame(sub.clientId, { type: 'work-graph', action: 'message', subscriptionGeneration: sub.subscriptionGeneration, message });
    }
    /** Stop a subscription, optionally sending one last stream message. */
    async end(sub, last) {
        if (!sub.active)
            return;
        this.forget(sub);
        if (last !== undefined)
            this.deliver(sub, last);
        if (sub.routed)
            await this.releaseRoute(sub.clientId, sub.channel);
    }
    forget(sub) {
        sub.active = false;
        const subs = this.byClient.get(sub.clientId);
        if (subs?.get(sub.subscriptionGeneration) === sub) {
            subs.delete(sub.subscriptionGeneration);
            if (subs.size === 0)
                this.byClient.delete(sub.clientId);
        }
        const onChannel = this.byChannel.get(sub.channel);
        if (onChannel) {
            onChannel.delete(sub);
            if (onChannel.size === 0)
                this.byChannel.delete(sub.channel);
        }
    }
    /** Drop the router subscription unless another live generation of this client still uses it. */
    async releaseRoute(clientId, channel) {
        for (const other of this.byClient.get(clientId)?.values() ?? []) {
            if (other.active && other.routed && other.channel === channel)
                return;
        }
        try {
            await this.router.unsubscribeFromChannel?.(clientId, channel);
        }
        catch { /* best effort */ }
    }
    index(sub) {
        let set = this.byChannel.get(sub.channel);
        if (!set) {
            set = new Set();
            this.byChannel.set(sub.channel, set);
        }
        set.add(sub);
    }
    current(sub) {
        return sub.active && this.byClient.get(sub.clientId)?.get(sub.subscriptionGeneration) === sub;
    }
    view(sub) {
        return Object.freeze({
            clientId: sub.clientId,
            userContext: sub.userContext,
            channel: sub.channel,
            scope: Object.freeze({ ...sub.scope }),
            subscriptionGeneration: sub.subscriptionGeneration,
            cursor: sub.cursor,
            ...(sub.activity ? { activity: Object.freeze({ ...sub.activity }) } : {}),
            ...(sub.viewPatch ? { viewPatch: sub.viewPatch } : {}),
            ...(sub.baseViewHash ? { baseViewHash: sub.baseViewHash } : {}),
        });
    }
    async mapChannel(clientId, scope, userContext, awaitAccess) {
        if (!this.channelFor)
            return null;
        try {
            const mapped = await this.channelFor({ ...scope }, { clientId, userContext, awaitAccess });
            return boundedString(mapped, this.maxChannelLength) ? mapped : null;
        }
        catch (err) {
            this.logger.warn('[work-graph] channelFor threw; refusing', err);
            return null;
        }
    }
    contextOf(clientId) {
        try {
            return this.router.getClientData?.(clientId)?.userContext ?? null;
        }
        catch {
            return null;
        }
    }
    frame(clientId, frame) {
        try {
            const r = this.router.sendToClient(clientId, frame);
            if (r && typeof r.then === 'function')
                r.then(undefined, () => undefined);
        }
        catch { /* a closed socket */ }
    }
    refuse(clientId, generation, message, code) {
        this.frame(clientId, {
            type: 'error', service: exports.WORK_GRAPH_SERVICE, code,
            ...(generation ? { subscriptionGeneration: generation } : {}),
            message, timestamp: new Date().toISOString(),
        });
    }
}
exports.WorkGraphStreamService = WorkGraphStreamService;
//# sourceMappingURL=streamService.js.map