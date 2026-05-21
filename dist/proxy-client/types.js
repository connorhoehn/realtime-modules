"use strict";
// realtime-modules/src/proxy-client/types.ts
//
// Public type surface for the HTTP-shim client.
//
// Re-exports the wire shapes from sibling subpaths so Lambda-native consumers
// (OrgIQ, future App #3) don't have to thread a second import path for every
// payload they touch. Only the types that today's REAL gateway HTTP surface
// (GET /health, /cluster, /stats, /metrics + POST /hooks/pipeline/:path) plus
// the once-they-ship presence/chat/activity REST endpoints will return are
// re-exported here — anything else stays in its native subpath.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyClientTimeoutError = exports.ProxyClientHttpError = exports.ProxyClientNetworkError = exports.ProxyClientError = void 0;
/**
 * Base class for all proxy-client errors. Callers can `instanceof` against
 * this OR against one of the more specific subclasses (network / HTTP /
 * timeout). The `cause` field on network errors is the original Error from
 * fetch; the `status` + `body` fields on HTTP errors carry the response.
 */
class ProxyClientError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'ProxyClientError';
    }
}
exports.ProxyClientError = ProxyClientError;
/** Thrown when the network call itself fails (DNS, refused, mid-flight reset). */
class ProxyClientNetworkError extends ProxyClientError {
    constructor(message, cause) {
        super(message, cause);
        this.name = 'ProxyClientNetworkError';
    }
}
exports.ProxyClientNetworkError = ProxyClientNetworkError;
/** Thrown when the gateway returns a non-2xx HTTP status. */
class ProxyClientHttpError extends ProxyClientError {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = 'ProxyClientHttpError';
    }
}
exports.ProxyClientHttpError = ProxyClientHttpError;
/** Thrown when the per-request timeout fires before the response arrives. */
class ProxyClientTimeoutError extends ProxyClientError {
    timeoutMs;
    constructor(message, timeoutMs) {
        super(message);
        this.timeoutMs = timeoutMs;
        this.name = 'ProxyClientTimeoutError';
    }
}
exports.ProxyClientTimeoutError = ProxyClientTimeoutError;
//# sourceMappingURL=types.js.map