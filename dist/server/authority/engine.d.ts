import type { AuthorityScope } from '../../server-ws/authorityScope';
import type { ChannelFamilies, ChannelFamily, ChannelKind, ChannelShapeGuard, GuardAuth, ShapeGuard } from './families';
/** The socket (or REST stand-in) context a decision is asked for. */
export type AuthorityContext = Record<string, unknown> | null;
/** What a host step answers: refuse, pass, or pass-with-a-recheck after the reload. */
export type AuthorityStepResult<P> = boolean | undefined | {
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
    channel(args: ChannelAuthorization & {
        base: string;
    }, kit: AuthorityKit<P>): Promise<boolean> | boolean;
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
    authorizeCall(ctx: AuthorityContext, action: string, data: Record<string, unknown> | null | undefined, opts?: {
        getLobby?: (callId: string) => Promise<string | null> | string | null;
    }): Promise<boolean>;
    /** May a call frame about `data` be DELIVERED to this context NOW (its own authority)? */
    authorizeCallRecipient(ctx: AuthorityContext, data: Record<string, unknown> | null | undefined, opts?: {
        getLobby?: (callId: string) => Promise<string | null> | string | null;
    }): Promise<boolean>;
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
/** `{ data: { callId, lobbyName } }` → flat, exactly as the call service reads it. */
export declare function normalizeCallPayload(data: Record<string, unknown> | null | undefined): Record<string, unknown>;
/**
 * Compose the fresh-per-request authority over a family table. See the file
 * header for the order; every method fails closed and caches nothing.
 */
export declare function createChannelAuthority<P, A, F extends ChannelFamily<A> = ChannelFamily<A>>(opts: CreateChannelAuthorityOptions<P, A, F>): ChannelAuthority<P, A, F>;
//# sourceMappingURL=engine.d.ts.map