"use strict";
// realtime-modules/src/server-ws/senderIdentity.ts
//
// Who sent a frame, according to the server rather than the frame.
//
// Chat, presence and reactions used to carry the sender's name from the
// frame (`metadata.displayName`, "sender-provided metadata wins"), so any
// socket could speak under somebody else's name while the gateway's auth
// context already knew who the connection was. Once a connection is
// authenticated, the frame's copies of these fields are advisory: they are
// dropped and replaced with the identity below.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SENDER_FIELDS = void 0;
exports.authContextOf = authContextOf;
exports.senderFromContext = senderFromContext;
exports.resolveAuthSender = resolveAuthSender;
exports.stampSender = stampSender;
/** Frame / metadata keys that name the sender. */
exports.SENDER_FIELDS = ['userId', 'displayName', 'avatarUrl'];
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : undefined);
/** The auth context the router holds for a connection, or null. */
function authContextOf(router, clientId) {
    const get = router?.getClientData;
    if (typeof get !== 'function')
        return null;
    try {
        const ctx = get.call(router, clientId)?.userContext;
        return ctx && typeof ctx === 'object' ? ctx : null;
    }
    catch {
        return null;
    }
}
/**
 * The default mapping: `userId`, `displayName` (or `name`), `avatarUrl` (or
 * `picture`) and `org` straight off the context. Null without a userId.
 */
function senderFromContext(ctx) {
    const userId = str(ctx.userId);
    if (!userId)
        return null;
    const displayName = str(ctx.displayName) ?? str(ctx.name);
    const avatarUrl = str(ctx.avatarUrl) ?? str(ctx.picture);
    const org = str(ctx.org);
    return {
        userId,
        ...(displayName ? { displayName } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
        ...(org ? { org } : {}),
    };
}
/**
 * The authenticated sender of `clientId`, or null when the connection has no
 * auth context with a userId (anonymous / dev mode). A custom `resolveSender`
 * runs only for an authenticated context; a throw or a result without a
 * userId counts as "no identity".
 */
function resolveAuthSender(router, clientId, frame, resolveSender, onError) {
    const ctx = authContextOf(router, clientId);
    if (!ctx || !str(ctx.userId))
        return null;
    if (!resolveSender)
        return senderFromContext(ctx);
    try {
        const out = resolveSender(ctx, frame && typeof frame === 'object' ? frame : {});
        if (!out || !str(out.userId))
            return null;
        return {
            userId: out.userId,
            ...(str(out.displayName) ? { displayName: out.displayName } : {}),
            ...(str(out.avatarUrl) ? { avatarUrl: out.avatarUrl } : {}),
            ...(str(out.org) ? { org: out.org } : {}),
        };
    }
    catch (err) {
        onError?.(err);
        return null;
    }
}
/**
 * A copy of `metadata` whose sender fields come from `sender`, not the frame:
 * the frame's `userId` / `displayName` / `avatarUrl` are removed, then the
 * sender's `displayName` / `avatarUrl` (and `userId` when `withUserId`) are
 * set where known.
 */
function stampSender(metadata, sender, opts = {}) {
    const out = { ...(metadata ?? {}) };
    for (const k of exports.SENDER_FIELDS)
        delete out[k];
    if (opts.withUserId && sender.userId)
        out.userId = sender.userId;
    if (sender.displayName !== undefined)
        out.displayName = sender.displayName;
    if (sender.avatarUrl !== undefined)
        out.avatarUrl = sender.avatarUrl;
    return out;
}
//# sourceMappingURL=senderIdentity.js.map