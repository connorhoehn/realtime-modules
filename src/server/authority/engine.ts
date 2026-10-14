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

import type { AuthorityScope } from '../../server-ws/authorityScope';
import { baseChannel } from '../../server-ws/channelAccess';
import type { ChannelFamilies, ChannelFamily, ChannelKind, ChannelShapeGuard, GuardAuth, ShapeGuard } from './families';

/** The socket (or REST stand-in) context a decision is asked for. */
export type AuthorityContext = Record<string, unknown> | null;

/** What a host step answers: refuse, pass, or pass-with-a-recheck after the reload. */
export type AuthorityStepResult<P> =
    | boolean
    | undefined
    | {
        /** Sync recheck against the RELOADED principal (a grant still held, a proof not yet invalidated). */
        recheck?: (latest: P) => boolean;
        /** Release whatever the step holds (an observer); always called. */
        dispose?: () => void;
    };

export interface ChannelQuestion {
    kind: ChannelKind;
    clientId: string;
    /** The router channel as asked (may carry a service prefix). */
    channel: string;
    /** `baseChannel(channel)`. */
    base: string;
    ctx: AuthorityContext;
    scope?: AuthorityScope;
}

export interface CallQuestion {
    action: string;
    /** The resolved lobby (stored call first, then the frame's), or null. */
    lobby: string | null;
    /** True for a delivery check (the recipient's own authority). */
    receiving: boolean;
    ctx: AuthorityContext;
    payload: Record<string, unknown>;
}

export type ChannelStep<P> = (principal: P, q: ChannelQuestion) => AuthorityStepResult<P> | Promise<AuthorityStepResult<P>>;
export type CallStep<P> = (principal: P, q: CallQuestion) => AuthorityStepResult<P> | Promise<AuthorityStepResult<P>>;

export interface ChannelAuthorization {
    kind: ChannelKind;
    clientId: string;
    channel: string;
    ctx: AuthorityContext;
    scope?: AuthorityScope;
}

/** What a host namespace handler receives to compose its own decision. */
export interface AuthorityKit<P> {
    load(ctx: AuthorityContext): Promise<P>;
    auth(principal: P): GuardAuth;
    guard: ChannelShapeGuard;
    lobbyGuard: ShapeGuard;
    /** The engine's own channel decision (for a handler that defers to another name). */
    authorizeChannel(args: ChannelAuthorization): Promise<boolean>;
}

export interface ChannelNamespaceHandler<P> {
    id: string;
    match(base: string): boolean;
    /** The whole channel decision for the namespace (the engine only catches throws). */
    channel(args: ChannelAuthorization & { base: string }, kit: AuthorityKit<P>): Promise<boolean> | boolean;
}

export interface CreateChannelAuthorityOptions<P, A, F extends ChannelFamily<A>> {
    families: ChannelFamilies<A, F>;
    principal: {
        /** Load the CURRENT principal for a context. Throw (or reject) to refuse. Called fresh, never cached here. */
        load(ctx: AuthorityContext): P | Promise<P>;
        /** The guard view of a principal (`{ userId, org, tenants, … }`) the shape guards read. */
        auth(principal: P): GuardAuth;
        /** The authenticated user id of a principal. Default `auth(principal).userId`. */
        userId?(principal: P): string;
    };
    /** Does the principal hold this family authority NOW (policy I/O allowed)? */
    holds(principal: P, authority: A): boolean | Promise<boolean>;
    /** The sync half of `holds`, asked again on the reloaded principal (grant/tenant still current). */
    meets(principal: P, authority: A): boolean;
    /** A family resource read now (`channelResource` / `lobbyResource`). Absent: any resource kind refuses. */
    resource?(kind: string, name: string, principal: P, use: 'channel' | 'lobby'): boolean | Promise<boolean>;
    /** Host steps on every channel decision, after the first load (e.g. a Social action + membership proof). */
    channelSteps?: readonly ChannelStep<P>[];
    /** Host steps on every call decision, after the lobby is resolved. */
    callSteps?: readonly CallStep<P>[];
    /** Host namespaces whose channel decision the host composes itself. */
    namespaces?: readonly ChannelNamespaceHandler<P>[];
    /** Override the channel shape guard (default `families.guard`). */
    guard?: ChannelShapeGuard;
    /** Override the lobby shape guard (default `families.lobbyGuard`). */
    lobbyGuard?: ShapeGuard;
    /** Reload the principal after host/policy I/O and recheck against it. Default true; false only for tests of the first phase. */
    recheckAfterIo?: boolean;
    /** An `invite` must name the authenticated caller as `callerId`. Default true. */
    verifyCaller?: boolean;
}

/** The four-way lobby verdict (`authorizeLobby`). */
export type LobbyVerdict = 'ok' | 'not-a-lobby' | 'gone' | 'denied';

export interface ChannelAuthority<P, A, F extends ChannelFamily<A>> {
    readonly families: ChannelFamilies<A, F>;
    readonly guard: ChannelShapeGuard;
    readonly lobbyGuard: ShapeGuard;
    /** May this context subscribe to / publish on `channel` NOW? (the router's `authorize`). */
    authorizeChannel(args: ChannelAuthorization): Promise<boolean>;
    /** A call frame (`invite`/`join`/`accepted`/…) from this context NOW. */
    authorizeCall(ctx: AuthorityContext, action: string, data: Record<string, unknown> | null | undefined,
        opts?: { getLobby?: (callId: string) => Promise<string | null> | string | null }): Promise<boolean>;
    /** May a call frame about `data` be DELIVERED to this context NOW (its own authority)? */
    authorizeCallRecipient(ctx: AuthorityContext, data: Record<string, unknown> | null | undefined,
        opts?: { getLobby?: (callId: string) => Promise<string | null> | string | null }): Promise<boolean>;
    /**
     * One lobby verdict for a page lobby: `read` (its call history) or `join`
     * (enter its call). `not-a-lobby`: no governed family lists it as a lobby;
     * `gone`: its resource is not there now; `denied`: everything else.
     */
    authorizeLobby(ctx: AuthorityContext, name: string, mode: 'read' | 'join'): Promise<LobbyVerdict>;
    /** A principal's family authority on `channel` (read for subscribe, write for publish), asked fresh. */
    holdsFamily(principal: P, channel: string, kind: ChannelKind): Promise<boolean>;
    /** Is the context's principal still current (loads fresh)? */
    current(ctx: AuthorityContext): Promise<boolean>;
}

type Collected<P> = { rechecks: Array<(latest: P) => boolean>; disposers: Array<() => void> };

/** Run one host step; false = refuse. Collects its recheck/dispose. */
async function runStep<P>(result: AuthorityStepResult<P> | Promise<AuthorityStepResult<P>>, into: Collected<P>): Promise<boolean> {
    const settled = await result;
    if (settled === false) return false;
    if (settled === undefined || settled === true) return true;
    if (settled.dispose) into.disposers.push(settled.dispose);
    if (settled.recheck) into.rechecks.push(settled.recheck);
    return true;
}

function disposeAll<P>(collected: Collected<P>): void {
    for (const dispose of collected.disposers) { try { dispose(); } catch { /* best effort */ } }
}

/** `{ data: { callId, lobbyName } }` → flat, exactly as the call service reads it. */
export function normalizeCallPayload(data: Record<string, unknown> | null | undefined): Record<string, unknown> {
    let payload: Record<string, unknown> = data ?? {};
    const nested = payload.data;
    if (payload.callId == null && payload.lobbyName == null && nested && typeof nested === 'object' && !Array.isArray(nested)) {
        payload = { ...(nested as Record<string, unknown>), ...payload };
    }
    return payload;
}

/**
 * Compose the fresh-per-request authority over a family table. See the file
 * header for the order; every method fails closed and caches nothing.
 */
export function createChannelAuthority<P, A, F extends ChannelFamily<A> = ChannelFamily<A>>(
    opts: CreateChannelAuthorityOptions<P, A, F>,
): ChannelAuthority<P, A, F> {
    const { families } = opts;
    const guard = opts.guard ?? families.guard;
    const lobbyGuard = opts.lobbyGuard ?? families.lobbyGuard;
    const recheckAfterIo = opts.recheckAfterIo !== false;
    const verifyCaller = opts.verifyCaller !== false;
    const load = async (ctx: AuthorityContext): Promise<P> => {
        if (ctx == null) throw new Error('unauthenticated');
        return await opts.principal.load(ctx);
    };
    const authOf = (principal: P): GuardAuth => opts.principal.auth(principal);
    const userIdOf = (principal: P): string => {
        const id = opts.principal.userId ? opts.principal.userId(principal) : authOf(principal).userId;
        return typeof id === 'string' ? id : '';
    };
    const resource = async (kind: string, name: string, principal: P, use: 'channel' | 'lobby'): Promise<boolean> =>
        !!opts.resource && (await opts.resource(kind, name, principal, use)) === true;

    const authorizeChannel = async (args: ChannelAuthorization): Promise<boolean> => {
        const collected: Collected<P> = { rechecks: [], disposers: [] };
        try {
            if (!args || (args.kind !== 'subscribe' && args.kind !== 'publish') || typeof args.channel !== 'string') return false;
            const base = baseChannel(args.channel);
            const handler = opts.namespaces?.find((ns) => { try { return ns.match(base); } catch { return false; } });
            if (handler) return (await handler.channel({ ...args, base }, kit)) === true;
            let principal = await load(args.ctx);
            let io = false;
            const q: ChannelQuestion = { kind: args.kind, clientId: args.clientId, channel: args.channel, base, ctx: args.ctx,
                ...(args.scope ? { scope: args.scope } : {}) };
            for (const step of opts.channelSteps ?? []) {
                io = true;
                if (!await runStep(step(principal, q), collected)) return false;
            }
            const family = families.familyOf(base);
            if (family) {
                const authority = families.authorityFor(family, args.channel, args.kind);
                if (authority === null || !await opts.holds(principal, authority)) return false;
                io = true;
                if (family.channelResource && !await resource(family.channelResource, base, principal, 'channel')) return false;
                collected.rechecks.push((latest) => opts.meets(latest, authority));
            }
            if (io && recheckAfterIo) principal = await load(args.ctx);
            for (const recheck of collected.rechecks) if (!recheck(principal)) return false;
            return guard(authOf(principal), args.channel, args.kind) === true;
        } catch { return false; } finally { disposeAll(collected); }
    };

    const kit: AuthorityKit<P> = { load, auth: authOf, guard, lobbyGuard, authorizeChannel };

    /** The call decision, with the reason a lobby verdict needs. */
    const callDecision = async (ctx: AuthorityContext, action: string, data: Record<string, unknown> | null | undefined,
        getLobby: ((callId: string) => Promise<string | null> | string | null) | undefined, receiving: boolean): Promise<LobbyVerdict> => {
        const collected: Collected<P> = { rechecks: [], disposers: [] };
        try {
            let principal = await load(ctx);
            const payload = normalizeCallPayload(data);
            if (verifyCaller && action === 'invite' && (payload.callerId !== userIdOf(principal) || !userIdOf(principal))) return 'denied';
            const explicit = typeof payload.lobbyName === 'string' && payload.lobbyName ? payload.lobbyName : null;
            const callId = typeof payload.callId === 'string' && payload.callId ? payload.callId : null;
            const stored = callId && getLobby ? await getLobby(callId) : null;
            // A frame cannot rename a stored call into another lobby.
            if (stored && explicit && stored !== explicit) return 'denied';
            const lobby = stored ?? explicit;
            if (lobby) {
                const ns = families.namespaceOf(lobby);
                if (ns && ns.lobby !== true) return 'not-a-lobby';
            }
            if (receiving && !lobby) return 'denied';
            const q: CallQuestion = { action, lobby, receiving, ctx, payload };
            for (const step of opts.callSteps ?? []) {
                if (!await runStep(step(principal, q), collected)) return 'denied';
            }
            const family = lobby ? families.familyOf(lobby) : null;
            if (family && family.lobby !== true) return 'not-a-lobby';
            if (family && !await opts.holds(principal, family.read)) return 'denied';
            if (family?.lobbyResource && lobby && !await resource(family.lobbyResource, lobby, principal, 'lobby')) return 'gone';
            if (family) collected.rechecks.push((latest) => opts.meets(latest, family.read));
            if (recheckAfterIo) principal = await load(ctx);
            for (const recheck of collected.rechecks) if (!recheck(principal)) return 'denied';
            return !lobby || lobbyGuard(authOf(principal), lobby) ? 'ok' : 'denied';
        } catch { return 'denied'; } finally { disposeAll(collected); }
    };

    const authorizeLobbyRead = async (ctx: AuthorityContext, lobby: string): Promise<LobbyVerdict> => {
        const family = typeof lobby === 'string' ? families.lobbyFamily(lobby) : null;
        if (!family) return 'not-a-lobby';
        try {
            let principal = await load(ctx);
            if (!await opts.holds(principal, family.read)) return 'denied';
            if (family.lobbyResource && !await resource(family.lobbyResource, lobby, principal, 'lobby')) return 'gone';
            if (recheckAfterIo) principal = await load(ctx);
            return opts.meets(principal, family.read) && lobbyGuard(authOf(principal), lobby) ? 'ok' : 'denied';
        } catch { return 'denied'; }
    };

    return {
        families,
        guard,
        lobbyGuard,
        authorizeChannel,
        authorizeCall: async (ctx, action, data, o = {}) => (await callDecision(ctx, action, data, o.getLobby, false)) === 'ok',
        authorizeCallRecipient: async (ctx, data, o = {}) => (await callDecision(ctx, 'receive', data, o.getLobby, true)) === 'ok',
        authorizeLobby: async (ctx, name, mode) => {
            if (mode === 'read') return authorizeLobbyRead(ctx, name);
            if (mode !== 'join' || typeof name !== 'string' || !name) return 'denied';
            if (!families.lobbyFamily(name)) return 'not-a-lobby';
            return callDecision(ctx, 'join', { lobbyName: name }, undefined, false);
        },
        holdsFamily: async (principal, channel, kind) => {
            try {
                const family = families.familyOf(baseChannel(channel));
                const authority = family ? families.authorityFor(family, channel, kind) : null;
                return authority !== null && (await opts.holds(principal, authority)) === true;
            } catch { return false; }
        },
        current: async (ctx) => {
            try { await load(ctx); return true; } catch { return false; }
        },
    };
}
