"use strict";
// realtime-modules/src/client/sharedSocketTransport.ts
//
// One host-owned WebSocket shared by several consumers (v0.144.0).
//
// `useWebSocket` takes a single `onMessage`, and the server keeps ONE
// subscription per socket and channel. An app that owns its socket and hands
// it to several consumers — `usePipelineRunStatus` instances, ui-components'
// `EventStreamProvider` (`channelTransport`), its own frame handler — needs
// three things the bare socket does not give it:
//
//   1. fan-out: every inbound frame reaches every registered handler;
//   2. reference-counted channels: the first holder sends the subscribe frame,
//      the last release sends the unsubscribe, so two views of one run do not
//      unsubscribe each other;
//   3. re-subscription: a new session epoch is a new server connection that
//      has subscribed to nothing, so every held channel is sent again, once.
//
// Frames are the server's: `{ service: 'pipeline' | 'subscribe', action:
// 'subscribe' | 'unsubscribe', channel }`. `pipeline:*` channels default to the
// `pipeline` service (the `pipeline()` feature's gate); anything else to the
// generic `subscribe` service. Since 0.143.0 the `subscribe` service defers
// `pipeline:` channels to the pipeline feature, so either route reaches the
// same gate.
//
// Framework-free: the React binding is `useSharedSocketTransport` /
// `useSharedWebSocket` (./useSharedSocketTransport).
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultChannelService = defaultChannelService;
exports.createSharedSocketTransport = createSharedSocketTransport;
/** `'pipeline'` for `pipeline:*` channels, else `'subscribe'`. */
function defaultChannelService(channel) {
    return channel.startsWith('pipeline:') ? 'pipeline' : 'subscribe';
}
// The session key when the host gives no epoch.
const UNTRACKED = -1;
const isObject = (v) => !!v && typeof v === 'object';
/**
 * An error frame refusing a subscribe: `PIPELINE_CHANNEL_REFUSED`, or the
 * router's `AUTHZ_CHANNEL_DENIED` with `kind: 'subscribe'` (a refused publish
 * on a channel leaves the subscription alone), or an error naming the channel
 * with neither code nor kind.
 */
function isSubscribeRefusal(f) {
    if (f.type !== 'error')
        return false;
    if (f.code === 'PIPELINE_CHANNEL_REFUSED')
        return true;
    if (f.code === 'AUTHZ_CHANNEL_DENIED')
        return f.kind === undefined || f.kind === 'subscribe';
    return f.code === undefined && f.kind === undefined;
}
/** One host socket, shared: fan-out, refcounted channels, re-subscription per session epoch. */
function createSharedSocketTransport(options = {}) {
    let send = options.send;
    let epoch = options.sessionEpoch;
    let isOpen = options.isOpen;
    const scheduleRelease = options.scheduleRelease ?? ((fn) => queueMicrotask(fn));
    const onHandlerError = options.onHandlerError ?? ((error) => {
        // eslint-disable-next-line no-console
        console.error('[realtime-modules] shared socket handler threw', error);
    });
    const handlers = new Set();
    const stateHandlers = new Set();
    const notify = (channel, state) => {
        for (const fn of [...stateHandlers]) {
            try {
                fn(channel, state);
            }
            catch (err) {
                onHandlerError(err, { channel, state });
            }
        }
    };
    const setState = (channel, h, state) => {
        if (h.state === state)
            return;
        h.state = state;
        notify(channel, state);
    };
    const held = new Map();
    const pending = new Set();
    let flushScheduled = false;
    const sessionKey = () => (epoch === undefined ? UNTRACKED : epoch);
    const canSubscribe = () => !!send && epoch !== 0 && (isOpen ? isOpen() : true);
    const frame = (h, action, channel) => ({ service: h.service, action, channel });
    const sendSubscribe = (channel, h) => {
        if (h.sentIn === sessionKey() || !canSubscribe())
            return;
        h.sentIn = sessionKey();
        // A (re-)sent subscribe awaits a fresh answer.
        setState(channel, h, 'pending');
        send(frame(h, 'subscribe', channel));
    };
    const flush = () => {
        flushScheduled = false;
        const channels = [...pending];
        pending.clear();
        for (const channel of channels) {
            const h = held.get(channel);
            if (!h || h.count > 0)
                continue;
            held.delete(channel);
            notify(channel, 'unheld');
            // Only a channel this session subscribed needs leaving.
            if (h.sentIn === sessionKey() && canSubscribe())
                send(frame(h, 'unsubscribe', channel));
        }
    };
    const subscribe = (channel, opts) => {
        let h = held.get(channel);
        if (!h) {
            h = { count: 0, service: opts?.service ?? defaultChannelService(channel), sentIn: null, state: 'pending' };
            held.set(channel, h);
            notify(channel, 'pending');
        }
        h.count += 1;
        pending.delete(channel);
        sendSubscribe(channel, h);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            const cur = held.get(channel);
            if (!cur)
                return;
            cur.count -= 1;
            if (cur.count > 0)
                return;
            pending.add(channel);
            if (!flushScheduled) {
                flushScheduled = true;
                scheduleRelease(flush);
            }
        };
    };
    const resubscribe = () => {
        for (const [channel, h] of held) {
            if (h.count > 0)
                sendSubscribe(channel, h);
        }
    };
    const update = (next) => {
        if ('send' in next)
            send = next.send;
        if ('isOpen' in next)
            isOpen = next.isOpen;
        if (!('sessionEpoch' in next) || next.sessionEpoch === epoch) {
            resubscribe();
            return;
        }
        epoch = next.sessionEpoch;
        // A new connection: what the old one was subscribed to is gone with it.
        for (const [channel, h] of [...held]) {
            h.sentIn = null;
            if (h.count === 0) {
                held.delete(channel);
                pending.delete(channel);
                notify(channel, 'unheld');
                continue;
            }
            setState(channel, h, 'pending');
        }
        resubscribe();
    };
    // Acks and refusals of held channels, whichever service sent them.
    const track = (inbound) => {
        if (!isObject(inbound) || typeof inbound.channel !== 'string')
            return;
        const h = held.get(inbound.channel);
        if (!h || h.count === 0)
            return;
        if (inbound.action === 'subscribed' && inbound.type !== 'error')
            setState(inbound.channel, h, 'subscribed');
        else if (isSubscribeRefusal(inbound))
            setState(inbound.channel, h, 'refused');
    };
    const deliver = (inbound) => {
        track(inbound);
        for (const fn of [...handlers]) {
            try {
                fn(inbound);
            }
            catch (err) {
                onHandlerError(err, inbound);
            }
        }
    };
    const onMessage = (fn) => {
        handlers.add(fn);
        return () => { handlers.delete(fn); };
    };
    const sendRaw = (out) => { send?.(out); };
    // Releases taken through an adapter, per channel, newest last.
    const adapterHolds = () => {
        const releases = new Map();
        return {
            hold(channel, service) {
                const list = releases.get(channel) ?? [];
                list.push(subscribe(channel, service ? { service } : undefined));
                releases.set(channel, list);
            },
            release(channel) {
                const list = releases.get(channel);
                const release = list?.pop();
                if (list && list.length === 0)
                    releases.delete(channel);
                // An unsubscribe nobody here held is dropped: forwarding it would
                // unsubscribe another consumer's channel.
                release?.();
            },
        };
    };
    let pipelineAdapter;
    let channelAdapter;
    const transport = {
        deliver,
        onMessage,
        subscribe,
        send: sendRaw,
        update,
        resubscribe,
        flush,
        get sessionEpoch() { return epoch; },
        holds: () => new Map([...held].filter(([, h]) => h.count > 0).map(([c, h]) => [c, h.count])),
        channelState(channel) {
            const h = held.get(channel);
            return h && h.count > 0 ? h.state : 'unheld';
        },
        onChannelState(fn) {
            stateHandlers.add(fn);
            return () => { stateHandlers.delete(fn); };
        },
        asPipelineRunTransport() {
            if (pipelineAdapter)
                return pipelineAdapter;
            const holds = adapterHolds();
            pipelineAdapter = {
                send(out) {
                    if (isObject(out) && (out.service === 'pipeline' || out.service === 'subscribe')
                        && typeof out.channel === 'string' && out.channel
                        && (out.action === 'subscribe' || out.action === 'unsubscribe')) {
                        if (out.action === 'subscribe')
                            holds.hold(out.channel, out.service);
                        else
                            holds.release(out.channel);
                        return;
                    }
                    if (isObject(out))
                        sendRaw(out);
                },
                onMessage,
            };
            return pipelineAdapter;
        },
        asChannelTransport() {
            if (channelAdapter)
                return channelAdapter;
            const holds = adapterHolds();
            channelAdapter = {
                subscribe: (channel) => holds.hold(channel),
                unsubscribe: (channel) => holds.release(channel),
            };
            return channelAdapter;
        },
    };
    return transport;
}
//# sourceMappingURL=sharedSocketTransport.js.map