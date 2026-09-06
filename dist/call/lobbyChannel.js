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
exports.isDmLobby = isDmLobby;
exports.dmLobbyMembers = dmLobbyMembers;
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
 * True for BOTH dm lobby forms — member-addressed (`dm:alice:bob`) and hashed
 * group (`dmg:<hash>`). The lobby-side twin of `isDmChatChannel`.
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
    if (!lobby)
        return false;
    return lobby.startsWith('dm:') || lobby.startsWith('dmg:');
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
function dmLobbyMembers(lobby) {
    if (!lobby || !lobby.startsWith('dm:'))
        return null;
    const members = lobby.slice('dm:'.length).split(':').filter(Boolean);
    return members.length >= 2 ? members : null;
}
//# sourceMappingURL=lobbyChannel.js.map