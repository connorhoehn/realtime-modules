import type { WsAuthContext, WsHandlerHandle, WsHandlerOptions } from './types';
/** {@link InboundRateLimitOptions} defaults (lane R6). */
export declare const DEFAULT_INBOUND_FRAMES_PER_SECOND = 50;
/**
 * The token expiry the host's `auth` reported, in ms since the epoch, or null.
 * Reads `exp` the way a JWT carries it (seconds); a non-finite or
 * non-positive value means "no expiry known".
 */
export declare function tokenExpiryMs(ctx: WsAuthContext | null | undefined): number | null;
export declare function createWsHandler(opts: WsHandlerOptions): WsHandlerHandle;
//# sourceMappingURL=createWsHandler.d.ts.map