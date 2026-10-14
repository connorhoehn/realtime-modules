// realtime-modules/src/server/authority/bearer.ts
//
// 0.116 — the server half of the `bearer-token-v1` subprotocol the client
// (`useWebSocket`, `GatewaySocketProvider`) already speaks:
//
//   Sec-WebSocket-Protocol: bearer-token-v1, <token>
//
// The token rides the subprotocol list, never the URL (a query-string token
// lands in access logs) and never a cookie (a cookie-authenticated socket needs
// CSRF checks this path avoids). Verification stays the host's: an HS256
// realtime token, a service-runtime JWT, anything that returns an identity.

import type { IncomingMessage } from 'http';
import type { WsAuthContext, WsAuthFn } from '../../server-ws/types';

/** The marker the client offers first. */
export const BEARER_SUBPROTOCOL = 'bearer-token-v1';

/**
 * The typed auth context a multi-tenant host returns from `auth` and every
 * authority hook receives (`attachRealtime({ auth })`, `authorize`,
 * `lobbyGuard`, `resolveSender`). Only `userId` is required; the rest are the
 * fields the library's guards and senders read when present.
 */
export interface RealtimeAuthContext extends WsAuthContext {
    userId: string;
    displayName?: string;
    /** The partition (tenant) the caller is standing in. */
    org?: string;
    /** Every partition the caller holds a grant in. */
    tenants?: string[];
    role?: string;
    /** The host session epoch the token was minted under (fenced by `principal.revalidate`). */
    epoch?: number;
    /** When the host session was issued (seconds). */
    sessionIat?: number;
    /** A masquerading operator behind `userId`. */
    act?: { sub: string; epoch?: number };
    avatarUrl?: string;
}

/**
 * The token from a `Sec-WebSocket-Protocol` header, or null unless the header
 * is EXACTLY `<protocol>, <token>` (two entries, the marker first). Arrays
 * (repeated headers) are joined first. No fallback anywhere else.
 */
export function tokenFromSubprotocol(header: string | string[] | undefined | null, opts: { protocol?: string } = {}): string | null {
    const protocol = opts.protocol ?? BEARER_SUBPROTOCOL;
    const raw = Array.isArray(header) ? header.join(',') : header;
    if (typeof raw !== 'string' || !raw) return null;
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length !== 2 || parts[0] !== protocol) return null;
    return parts[1] ?? null;
}

export interface BearerSubprotocolAuthOptions<C extends WsAuthContext> {
    /** Verify the token and return the connection's identity. Throw/reject to refuse (401). */
    verify(token: string, req: IncomingMessage): C | Promise<C>;
    /** The marker. Default {@link BEARER_SUBPROTOCOL}. */
    protocol?: string;
    /**
     * Browser Origin check, asked when the upgrade carries an Origin header.
     * Return false to refuse. Absent: every origin passes (non-browser hosts).
     */
    allowOrigin?(origin: string, req: IncomingMessage): boolean;
}

/**
 * An `attachRealtime({ auth })` callback for the bearer subprotocol. Refuses
 * (the handler answers 401) on: a disallowed Origin, a missing or malformed
 * header, a failed `verify`, and a verified identity without a non-empty
 * string `userId`.
 */
export function bearerSubprotocolAuth<C extends WsAuthContext = RealtimeAuthContext>(opts: BearerSubprotocolAuthOptions<C>): WsAuthFn {
    return async (req) => {
        const origin = req.headers?.origin;
        if (typeof origin === 'string' && origin && opts.allowOrigin && opts.allowOrigin(origin, req) !== true) {
            throw new Error('browser origin is not allowed');
        }
        const token = tokenFromSubprotocol(req.headers?.['sec-websocket-protocol'], { protocol: opts.protocol });
        if (!token) throw new Error(`missing ${opts.protocol ?? BEARER_SUBPROTOCOL} subprotocol`);
        const ctx = await opts.verify(token, req);
        if (!ctx || typeof ctx.userId !== 'string' || !ctx.userId) throw new Error('verified token has no user');
        return ctx;
    };
}
