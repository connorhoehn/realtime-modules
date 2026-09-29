import type { WsAuthContext } from './types';
/** The sender as the server knows it. */
export interface AuthSender {
    userId: string;
    displayName?: string;
    avatarUrl?: string;
    org?: string;
}
/**
 * Map a connection's auth context (and the frame, for consumers that need
 * it) to the sender identity. Return null to treat the connection as
 * unidentified. The frame is untrusted input — use it only to pick between
 * identities the context already vouches for.
 */
export type ResolveSender = (ctx: WsAuthContext, frame: Record<string, unknown>) => {
    userId: string;
    displayName?: string;
    avatarUrl?: string;
    org?: string;
} | null | undefined;
/** Frame / metadata keys that name the sender. */
export declare const SENDER_FIELDS: readonly ["userId", "displayName", "avatarUrl"];
/** The auth context the router holds for a connection, or null. */
export declare function authContextOf(router: unknown, clientId: string): WsAuthContext | null;
/**
 * The default mapping: `userId`, `displayName` (or `name`), `avatarUrl` (or
 * `picture`) and `org` straight off the context. Null without a userId.
 */
export declare function senderFromContext(ctx: WsAuthContext): AuthSender | null;
/**
 * The authenticated sender of `clientId`, or null when the connection has no
 * auth context with a userId (anonymous / dev mode). A custom `resolveSender`
 * runs only for an authenticated context; a throw or a result without a
 * userId counts as "no identity".
 */
export declare function resolveAuthSender(router: unknown, clientId: string, frame: unknown, resolveSender?: ResolveSender | null, onError?: (err: unknown) => void): AuthSender | null;
/**
 * A copy of `metadata` whose sender fields come from `sender`, not the frame:
 * the frame's `userId` / `displayName` / `avatarUrl` are removed, then the
 * sender's `displayName` / `avatarUrl` (and `userId` when `withUserId`) are
 * set where known.
 */
export declare function stampSender(metadata: Record<string, unknown> | null | undefined, sender: {
    userId?: string;
    displayName?: string;
    avatarUrl?: string;
}, opts?: {
    withUserId?: boolean;
}): Record<string, unknown>;
//# sourceMappingURL=senderIdentity.d.ts.map