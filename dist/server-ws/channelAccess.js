"use strict";
// realtime-modules/src/server-ws/channelAccess.ts
//
// How a service asks the router's channel authz (`attachRealtime({ authorize })`)
// before it acts on a channel, and how a consumer's `authorize` reads the
// channel names services use.
//
// The router is the ONE enforcement point: `subscribeToChannel` runs
// `authorize({ kind: 'subscribe' })`, and `checkChannel` runs the same hook for
// the reads and writes that do not go through a subscription (a presence
// `set`, a reaction `send`, a chat `history`). Services never decide channel
// access themselves; they ask, and a refusal means no state change, no
// fan-out and no data handed back. The router sends the refused client the
// AUTHZ_CHANNEL_DENIED error frame.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SERVICE_CHANNEL_PREFIXES = void 0;
exports.splitServiceChannel = splitServiceChannel;
exports.routerPermits = routerPermits;
exports.channelDeniedFrame = channelDeniedFrame;
/**
 * Services that wrap the consumer's channel name in a prefix of their own
 * before handing it to the router. Every other service (chat, activity,
 * social, crdt, typed-documents' `doc:` / `doc-comments:`, ingest's and
 * pipeline's own namespaces) passes the name the client sent unchanged.
 */
exports.SERVICE_CHANNEL_PREFIXES = ['presence', 'reactions', 'cursor'];
/**
 * Split a router channel name into the wrapping service and the consumer's
 * channel. `presence:acme:lobby` → `{ service: 'presence', channel:
 * 'acme:lobby' }`; a name without a known service prefix (a chat channel,
 * `acme:lobby`) comes back unchanged with `service: null`.
 */
function splitServiceChannel(name) {
    const i = name.indexOf(':');
    if (i > 0) {
        const head = name.slice(0, i);
        if (exports.SERVICE_CHANNEL_PREFIXES.includes(head)) {
            return { service: head, channel: name.slice(i + 1) };
        }
    }
    return { service: null, channel: name };
}
/**
 * Ask the router whether `clientId` may `kind` `channel`. A router without
 * `checkChannel` (a custom transport that enforces only at fan-out) allows.
 * A throwing check refuses.
 */
async function routerPermits(router, kind, clientId, channel, opts) {
    if (!router || typeof router.checkChannel !== 'function')
        return true;
    try {
        return (await router.checkChannel(kind, clientId, channel, opts)) !== false;
    }
    catch {
        return false;
    }
}
/** The refusal frame — the gateway's `{ type: 'error', error: { code } }` shape plus flat fields. */
function channelDeniedFrame(args) {
    const message = args.kind === 'subscribe'
        ? `Not allowed to subscribe to ${args.channel}`
        : `Not allowed to publish to ${args.channel}`;
    const timestamp = new Date().toISOString();
    return {
        type: 'error',
        ...(args.service ? { service: args.service } : {}),
        code: 'AUTHZ_CHANNEL_DENIED',
        kind: args.kind,
        channel: args.channel,
        message,
        error: { code: 'AUTHZ_CHANNEL_DENIED', message, timestamp, ...(args.service ? { service: args.service } : {}) },
        timestamp,
    };
}
//# sourceMappingURL=channelAccess.js.map