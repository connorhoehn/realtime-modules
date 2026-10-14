"use strict";
// realtime-modules/src/server/authority/engine.ts
//
// 0.116 — the fresh-per-request authority a multi-tenant host composed by hand
// over its family table (aws-agentcore lib/live-principal.ts +
// lib/gateway/authority.ts). The library owns WHEN each check runs; the host
// supplies WHAT each one asks:
//
//   1. the shape (`families.guard` / `families.lobbyGuard`) — no I/O;
//   2. the principal, loaded fresh from the host's directory (`principal.load`
//      throws for a retired epoch, a revoked role, a stale actor);
//   3. host steps (`channelSteps` / `callSteps`: a Social action + membership
//      proof, anything partition-specific) and the family's authority
//      (`holds`) and resource (`resource`, the page existing now);
//   4. after any of that I/O, the principal again (`recheckAfterIo`), every
//      step's sync recheck and the family's `meets` against it, and the shape
//      once more on the reloaded identity.
//
// Fail closed everywhere: a throw anywhere is a refusal, and nothing settles —
// no verdict is cached between calls.
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeCallPayload = normalizeCallPayload;
exports.createChannelAuthority = createChannelAuthority;
const channelAccess_1 = require("../../server-ws/channelAccess");
/** Run one host step; false = refuse. Collects its recheck/dispose. */
async function runStep(result, into) {
    const settled = await result;
    if (settled === false)
        return false;
    if (settled === undefined || settled === true)
        return true;
    if (settled.dispose)
        into.disposers.push(settled.dispose);
    if (settled.recheck)
        into.rechecks.push(settled.recheck);
    return true;
}
function disposeAll(collected) {
    for (const dispose of collected.disposers) {
        try {
            dispose();
        }
        catch { /* best effort */ }
    }
}
/** `{ data: { callId, lobbyName } }` → flat, exactly as the call service reads it. */
function normalizeCallPayload(data) {
    let payload = data ?? {};
    const nested = payload.data;
    if (payload.callId == null && payload.lobbyName == null && nested && typeof nested === 'object' && !Array.isArray(nested)) {
        payload = { ...nested, ...payload };
    }
    return payload;
}
/**
 * Compose the fresh-per-request authority over a family table. See the file
 * header for the order; every method fails closed and caches nothing.
 */
function createChannelAuthority(opts) {
    const { families } = opts;
    const guard = opts.guard ?? families.guard;
    const lobbyGuard = opts.lobbyGuard ?? families.lobbyGuard;
    const recheckAfterIo = opts.recheckAfterIo !== false;
    const verifyCaller = opts.verifyCaller !== false;
    const load = async (ctx) => {
        if (ctx == null)
            throw new Error('unauthenticated');
        return await opts.principal.load(ctx);
    };
    const authOf = (principal) => opts.principal.auth(principal);
    const userIdOf = (principal) => {
        const id = opts.principal.userId ? opts.principal.userId(principal) : authOf(principal).userId;
        return typeof id === 'string' ? id : '';
    };
    const resource = async (kind, name, principal, use) => !!opts.resource && (await opts.resource(kind, name, principal, use)) === true;
    const authorizeChannel = async (args) => {
        const collected = { rechecks: [], disposers: [] };
        try {
            if (!args || (args.kind !== 'subscribe' && args.kind !== 'publish') || typeof args.channel !== 'string')
                return false;
            const base = (0, channelAccess_1.baseChannel)(args.channel);
            const handler = opts.namespaces?.find((ns) => { try {
                return ns.match(base);
            }
            catch {
                return false;
            } });
            if (handler)
                return (await handler.channel({ ...args, base }, kit)) === true;
            let principal = await load(args.ctx);
            let io = false;
            const q = { kind: args.kind, clientId: args.clientId, channel: args.channel, base, ctx: args.ctx,
                ...(args.scope ? { scope: args.scope } : {}) };
            for (const step of opts.channelSteps ?? []) {
                io = true;
                if (!await runStep(step(principal, q), collected))
                    return false;
            }
            const family = families.familyOf(base);
            if (family) {
                const authority = families.authorityFor(family, args.channel, args.kind);
                if (authority === null || !await opts.holds(principal, authority))
                    return false;
                io = true;
                if (family.channelResource && !await resource(family.channelResource, base, principal, 'channel'))
                    return false;
                collected.rechecks.push((latest) => opts.meets(latest, authority));
            }
            if (io && recheckAfterIo)
                principal = await load(args.ctx);
            for (const recheck of collected.rechecks)
                if (!recheck(principal))
                    return false;
            return guard(authOf(principal), args.channel, args.kind) === true;
        }
        catch {
            return false;
        }
        finally {
            disposeAll(collected);
        }
    };
    const kit = { load, auth: authOf, guard, lobbyGuard, authorizeChannel };
    /** The call decision, with the reason a lobby verdict needs. */
    const callDecision = async (ctx, action, data, getLobby, receiving) => {
        const collected = { rechecks: [], disposers: [] };
        try {
            let principal = await load(ctx);
            const payload = normalizeCallPayload(data);
            if (verifyCaller && action === 'invite' && (payload.callerId !== userIdOf(principal) || !userIdOf(principal)))
                return 'denied';
            const explicit = typeof payload.lobbyName === 'string' && payload.lobbyName ? payload.lobbyName : null;
            const callId = typeof payload.callId === 'string' && payload.callId ? payload.callId : null;
            const stored = callId && getLobby ? await getLobby(callId) : null;
            // A frame cannot rename a stored call into another lobby.
            if (stored && explicit && stored !== explicit)
                return 'denied';
            const lobby = stored ?? explicit;
            if (lobby) {
                const ns = families.namespaceOf(lobby);
                if (ns && ns.lobby !== true)
                    return 'not-a-lobby';
            }
            if (receiving && !lobby)
                return 'denied';
            const q = { action, lobby, receiving, ctx, payload };
            for (const step of opts.callSteps ?? []) {
                if (!await runStep(step(principal, q), collected))
                    return 'denied';
            }
            const family = lobby ? families.familyOf(lobby) : null;
            if (family && family.lobby !== true)
                return 'not-a-lobby';
            if (family && !await opts.holds(principal, family.read))
                return 'denied';
            if (family?.lobbyResource && lobby && !await resource(family.lobbyResource, lobby, principal, 'lobby'))
                return 'gone';
            if (family)
                collected.rechecks.push((latest) => opts.meets(latest, family.read));
            if (recheckAfterIo)
                principal = await load(ctx);
            for (const recheck of collected.rechecks)
                if (!recheck(principal))
                    return 'denied';
            return !lobby || lobbyGuard(authOf(principal), lobby) ? 'ok' : 'denied';
        }
        catch {
            return 'denied';
        }
        finally {
            disposeAll(collected);
        }
    };
    const authorizeLobbyRead = async (ctx, lobby) => {
        const family = typeof lobby === 'string' ? families.lobbyFamily(lobby) : null;
        if (!family)
            return 'not-a-lobby';
        try {
            let principal = await load(ctx);
            if (!await opts.holds(principal, family.read))
                return 'denied';
            if (family.lobbyResource && !await resource(family.lobbyResource, lobby, principal, 'lobby'))
                return 'gone';
            if (recheckAfterIo)
                principal = await load(ctx);
            return opts.meets(principal, family.read) && lobbyGuard(authOf(principal), lobby) ? 'ok' : 'denied';
        }
        catch {
            return 'denied';
        }
    };
    return {
        families,
        guard,
        lobbyGuard,
        authorizeChannel,
        authorizeCall: async (ctx, action, data, o = {}) => (await callDecision(ctx, action, data, o.getLobby, false)) === 'ok',
        authorizeCallRecipient: async (ctx, data, o = {}) => (await callDecision(ctx, 'receive', data, o.getLobby, true)) === 'ok',
        authorizeLobby: async (ctx, name, mode) => {
            if (mode === 'read')
                return authorizeLobbyRead(ctx, name);
            if (mode !== 'join' || typeof name !== 'string' || !name)
                return 'denied';
            if (!families.lobbyFamily(name))
                return 'not-a-lobby';
            return callDecision(ctx, 'join', { lobbyName: name }, undefined, false);
        },
        holdsFamily: async (principal, channel, kind) => {
            try {
                const family = families.familyOf((0, channelAccess_1.baseChannel)(channel));
                const authority = family ? families.authorityFor(family, channel, kind) : null;
                return authority !== null && (await opts.holds(principal, authority)) === true;
            }
            catch {
                return false;
            }
        },
        current: async (ctx) => {
            try {
                await load(ctx);
                return true;
            }
            catch {
                return false;
            }
        },
    };
}
//# sourceMappingURL=engine.js.map