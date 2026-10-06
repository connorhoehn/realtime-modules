"use strict";
// The mapping between a CALL and the CONVERSATION it happened in.
//
// A call is addressed by a lobby (`dm:alice:bob`, `room:design`) and a
// conversation by a channel (`chat:dm:alice:bob`, `room:design`). They are two
// names for one place, and until now each side of the system carried its own
// half of the rule: the frontend knew how to find a channel's lobby so it
// could list that channel's recordings, and the gateway needed the inverse so
// a finished call could post itself into the right thread.
//
// Two copies of one rule in two repos drift, and the failure is silent in
// both directions — a call posts into a channel nobody reads, or a
// conversation lists no recordings for calls it definitely had. So the rule
// lives here once, in both directions, with the round trip pinned by tests.
//
// Not every lobby has a conversation. An ad-hoc lobby with no thread behind it
// maps to null, which is an answer, not a failure.
//
// THREE conversation shapes carry a lobby, not two. A multi-party DM is
// addressed by its members (`chat:dm:a:b:c`) until that id would exceed the
// 100-char channel cap, at which point it becomes a HASHED group
// (`chat:dmg:<sha1>`). Both are the same product concept — a group chat — so
// both must map. Handling only the first meant a group silently lost calling
// once it grew past the cap: the same people in a smaller group could call,
// and nothing anywhere said why.
Object.defineProperty(exports, "__esModule", { value: true });
exports.lobbyForChannel = lobbyForChannel;
exports.channelForLobby = channelForLobby;
exports.lobbyForChatLobbyChannel = lobbyForChatLobbyChannel;
exports.dmLobbyName = dmLobbyName;
exports.isDmLobby = isDmLobby;
exports.lobbyConversationKind = lobbyConversationKind;
exports.dmLobbyMembers = dmLobbyMembers;
exports.shouldKnockToJoin = shouldKnockToJoin;
/** `chat:dm:alice:bob` → `dm:alice:bob`; `chat:dmg:<hash>` → `dmg:<hash>`;
 *  `room:design` → `room:design`. */
function lobbyForChannel(channel) {
    if (!channel)
        return null;
    // `chat:dmg:` is checked FIRST: it does not start with `chat:dm:` (the
    // eighth character is 'g', not ':'), so order is not load-bearing here —
    // but reading them together is how the pair stays obviously exhaustive.
    if (channel.startsWith('chat:dmg:'))
        return channel.slice('chat:'.length);
    if (channel.startsWith('chat:dm:'))
        return channel.slice('chat:'.length);
    if (channel.startsWith('room:'))
        return channel;
    // A plain channel (`general`) has no call lobby: calls are addressed to
    // people or to a room, and a bare channel is neither.
    return null;
}
/** `dm:alice:bob` → `chat:dm:alice:bob`; `dmg:<hash>` → `chat:dmg:<hash>`;
 *  `room:design` → `room:design`. */
function channelForLobby(lobby) {
    if (!lobby)
        return null;
    if (lobby.startsWith('dmg:') || lobby.startsWith('dm:'))
        return `chat:${lobby}`;
    if (lobby.startsWith('room:'))
        return lobby;
    return null;
}
/**
 * The inverse of `channelForLobby`'s `chat:` wrapping, read past a host's
 * tenant prefix: `chat:dm:a:b` → `dm:a:b`, `chat:dmg:<hash>` → `dmg:<hash>`,
 * `chat:acme:dm:a:b` → `acme:dm:a:b`. Anything else → null (`chat:general`,
 * `room:design`, `activity:broadcast`).
 *
 * `baseChannel` (`/server`) uses this to strip the `chat:` lobby form. It
 * lives HERE, next to `channelForLobby`, so the wrapping and its unwrapping
 * are one rule: if `channelForLobby` ever wraps another lobby kind in `chat:`,
 * this must unwrap it too, and the round-trip test in
 * test/call/lobbyChannel.test.ts fails until it does.
 */
function lobbyForChatLobbyChannel(channel) {
    if (!channel || !channel.startsWith('chat:'))
        return null;
    const rest = channel.slice('chat:'.length);
    const found = lobbyKindSegment(rest);
    if (!found || found.kind === 'room')
        return null;
    return rest;
}
/**
 * `dmLobbyName(['bob', 'alice'])` → `dm:alice:bob`;
 * `dmLobbyName(['bob', 'alice'], { prefix: 'acme:' })` → `acme:dm:alice:bob`.
 * Duplicates and empty ids are dropped; include yourself in `userIds`.
 * An id containing `:` throws: `:` separates the members, so `['a', 'b:c']`
 * and `['a:b', 'c']` would name the same lobby — two different calls, one
 * room — and the server's DM membership rule would read the wrong members.
 *
 * Pure and React-free: exported from `/call` for servers and from
 * `/client/video` for the conversation-call hooks. It never produces the
 * hashed `dmg:` form — that comes only from chat's `dmChatChannelFor` when a
 * member-addressed channel would exceed its length cap.
 */
function dmLobbyName(userIds, opts = {}) {
    const ids = Array.from(new Set(userIds.filter((u) => typeof u === 'string' && u.length > 0))).sort();
    const bad = ids.find((u) => u.includes(':'));
    if (bad !== undefined)
        throw new Error(`dmLobbyName: user id ${JSON.stringify(bad)} contains ':', the lobby's member separator`);
    return `${opts.prefix ?? ''}dm:${ids.join(':')}`;
}
/**
 * True for BOTH dm lobby forms — member-addressed (`dm:alice:bob`) and hashed
 * group (`dmg:<hash>`) — with or without a tenant prefix (`acme:dm:alice:bob`). The lobby-side twin of `isDmChatChannel`.
 *
 * It exists because five call sites across the app each wrote
 * `lobby.startsWith('dm:')` and each one silently excluded hashed groups. The
 * bugs that produced were not cosmetic: one skipped the knock-to-join gate, so
 * a private group call could be joined uninvited, and another ignored the
 * gateway's synthetic `ended` frame, so the call overlay never tore down.
 * `dmg:` does not start with `dm:` (the third character is `g`, not `:`), so
 * every such check needs both prefixes or it has a size-dependent hole.
 */
function isDmLobby(lobby) {
    // Reads past a tenant prefix (`acme:dm:a:b`, `acme:eu:dmg:<hash>`), the
    // same rule as `lobbyConversationKind`. A bare `startsWith('dm:')` let an
    // outsider walk into a tenant-prefixed DM call instead of knocking.
    return lobbyConversationKind(lobby) === 'dm';
}
/**
 * Index and value of the segment that names a lobby's kind — the first
 * `dm` / `dmg` / `room` segment that is not the last one (the last segment is
 * a name: a user id, a slug, a hash). Everything before it is a tenant prefix.
 */
function lobbyKindSegment(lobby) {
    if (!lobby)
        return null;
    const segments = lobby.split(':');
    for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        if (seg === 'dm' || seg === 'dmg' || seg === 'room')
            return { index: i, kind: seg, segments };
    }
    return null;
}
/**
 * What kind of conversation a lobby is, reading past a host's tenant prefix:
 * `dm:a:b`, `dmg:<hash>`, `acme:dm:a:b` and `acme:eu:dmg:<hash>` are `'dm'`;
 * `room:design` and `acme:room:design` are `'room'`; anything else is null.
 * The first `dm` / `dmg` / `room` segment decides, so `acme:room:dm-sync`
 * is a room.
 *
 * The server's lobby rules use this, not `isDmLobby`: `dmLobbyName(ids,
 * { prefix: 'acme:' })` puts the tenant first, and a `startsWith('dm:')` test
 * never matched it — so "a DM ends when one party hangs up" silently did not
 * apply to any tenant-prefixed DM.
 */
function lobbyConversationKind(lobby) {
    const found = lobbyKindSegment(lobby);
    if (!found)
        return null;
    return found.kind === 'room' ? 'room' : 'dm';
}
/**
 * Member userIds of a dm lobby, or null when they are not derivable.
 *
 * Null is an ANSWER, not a failure, and it means two different things that
 * callers must not conflate: a `room:`/ad-hoc lobby has no dm membership at
 * all, while a hashed `dmg:` lobby definitely has members that this name
 * cannot reveal — the hash is one-way by design. So null must never be read
 * as "not private". Pair it with `isDmLobby` and take the CLOSED branch:
 * private, membership unknown ⇒ ask to be let in.
 */
function dmLobbyMembers(lobby, opts = {}) {
    // Tenant prefix allowed: `acme:dm:alice:bob` → ['alice', 'bob'].
    const found = lobbyKindSegment(lobby);
    if (!found)
        return null;
    if (found.kind === 'dmg') {
        // A hashed group cannot be read from its name. A host that keeps the
        // group's roster (a conversations index) may answer through
        // `resolveGroup`; without it, or when it does not know, the answer stays
        // null — "private, membership unknown", which callers must treat closed.
        if (!opts.resolveGroup || !lobby)
            return null;
        let resolved;
        try {
            resolved = opts.resolveGroup(lobby);
        }
        catch {
            return null;
        }
        if (!Array.isArray(resolved))
            return null;
        const ids = Array.from(new Set(resolved.filter((u) => typeof u === 'string' && u.length > 0)));
        return ids.length >= 2 ? ids.sort() : null;
    }
    if (found.kind !== 'dm')
        return null;
    const members = found.segments.slice(found.index + 1).filter(Boolean);
    return members.length >= 2 ? members : null;
}
/**
 * Should `userId` knock to be let into `lobby`, rather than walking in?
 *
 * This encodes the pairing of the two helpers above, because getting that
 * pairing wrong is the bug they were extracted from: a caller read
 * "members not derivable" as "not private" and joined a hashed group call
 * uninvited.
 *
 * Open the door only when the lobby is not private, or when the name itself
 * proves the caller is a party to it. A hashed group proves nothing either
 * way, so it knocks — the closed branch is the safe one, and knocking is a
 * request, not a rejection.
 */
function shouldKnockToJoin(lobby, userId) {
    if (!isDmLobby(lobby))
        return false;
    const members = dmLobbyMembers(lobby);
    if (!members || !userId)
        return true;
    return !members.includes(userId);
}
//# sourceMappingURL=lobbyChannel.js.map