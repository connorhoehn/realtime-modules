/**
 * Services that wrap the consumer's channel name in a prefix of their own
 * before handing it to the router. Every other service (chat, activity,
 * social, crdt, typed-documents' `doc:` / `doc-comments:`, ingest's and
 * pipeline's own namespaces) passes the name the client sent unchanged.
 */
export declare const SERVICE_CHANNEL_PREFIXES: readonly ["presence", "reactions", "cursor"];
export type ServiceChannelPrefix = (typeof SERVICE_CHANNEL_PREFIXES)[number];
/**
 * Split a router channel name into the wrapping service and the consumer's
 * channel. `presence:acme:lobby` → `{ service: 'presence', channel:
 * 'acme:lobby' }`; a name without a known service prefix (a chat channel,
 * `acme:lobby`) comes back unchanged with `service: null`.
 */
export declare function splitServiceChannel(name: string): {
    service: ServiceChannelPrefix | null;
    channel: string;
};
export type ChannelAccessKind = 'subscribe' | 'publish';
/** Who is asking, for the refusal frame the router sends. */
export interface ChannelAccessOpts {
    /** The wire service name the refused frame addressed (`presence`, `reaction`, …). */
    service?: string;
    /** The channel as the client named it (the refusal echoes it). */
    clientChannel?: string;
    /**
     * Ask without telling the client on refusal (no AUTHZ_CHANNEL_DENIED
     * frame). For checks whose refusal must not be observable — a presence
     * `get` by `targetClientId` answers an unreadable target exactly like an
     * unknown one, so a refusal frame would leak that the target exists.
     */
    silent?: boolean;
}
/** The router slice a service needs to ask. Optional on every router. */
export interface ChannelAccessRouter {
    checkChannel?(kind: ChannelAccessKind, clientId: string, channel: string, opts?: ChannelAccessOpts): boolean | Promise<boolean>;
    /**
     * Whether a channel authz hook is configured at all. A router with
     * `checkChannel` but without this is assumed to enforce.
     */
    hasChannelAuthorize?(): boolean;
    subscribeToChannel?(clientId: string, channel: string, opts?: ChannelAccessOpts): Promise<boolean | void> | boolean | void;
}
/**
 * Ask the router whether `clientId` may `kind` `channel`. A router without
 * `checkChannel` (a custom transport that enforces only at fan-out) allows.
 * A throwing check refuses.
 */
export declare function routerPermits(router: ChannelAccessRouter | null | undefined, kind: ChannelAccessKind, clientId: string, channel: string, opts?: ChannelAccessOpts): Promise<boolean>;
/**
 * Whether `router` may refuse a channel at all: false only for a router with
 * no `checkChannel`, or one that says it has no `authorize` configured.
 */
export declare function routerEnforcesChannelAccess(router: ChannelAccessRouter | null | undefined): boolean;
/** The refusal frame — the gateway's `{ type: 'error', error: { code } }` shape plus flat fields. */
export declare function channelDeniedFrame(args: {
    kind: ChannelAccessKind;
    channel: string;
    service?: string;
}): Record<string, unknown>;
//# sourceMappingURL=channelAccess.d.ts.map