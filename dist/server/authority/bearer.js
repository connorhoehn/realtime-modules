"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.BEARER_SUBPROTOCOL = void 0;
exports.tokenFromSubprotocol = tokenFromSubprotocol;
exports.bearerSubprotocolAuth = bearerSubprotocolAuth;
/** The marker the client offers first. */
exports.BEARER_SUBPROTOCOL = 'bearer-token-v1';
/**
 * The token from a `Sec-WebSocket-Protocol` header, or null unless the header
 * is EXACTLY `<protocol>, <token>` (two entries, the marker first). Arrays
 * (repeated headers) are joined first. No fallback anywhere else.
 */
function tokenFromSubprotocol(header, opts = {}) {
    const protocol = opts.protocol ?? exports.BEARER_SUBPROTOCOL;
    const raw = Array.isArray(header) ? header.join(',') : header;
    if (typeof raw !== 'string' || !raw)
        return null;
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length !== 2 || parts[0] !== protocol)
        return null;
    return parts[1] ?? null;
}
/**
 * An `attachRealtime({ auth })` callback for the bearer subprotocol. Refuses
 * (the handler answers 401) on: a disallowed Origin, a missing or malformed
 * header, a failed `verify`, and a verified identity without a non-empty
 * string `userId`.
 */
function bearerSubprotocolAuth(opts) {
    return async (req) => {
        const origin = req.headers?.origin;
        if (typeof origin === 'string' && origin && opts.allowOrigin && opts.allowOrigin(origin, req) !== true) {
            throw new Error('browser origin is not allowed');
        }
        const token = tokenFromSubprotocol(req.headers?.['sec-websocket-protocol'], { protocol: opts.protocol });
        if (!token)
            throw new Error(`missing ${opts.protocol ?? exports.BEARER_SUBPROTOCOL} subprotocol`);
        const ctx = await opts.verify(token, req);
        if (!ctx || typeof ctx.userId !== 'string' || !ctx.userId)
            throw new Error('verified token has no user');
        return ctx;
    };
}
//# sourceMappingURL=bearer.js.map