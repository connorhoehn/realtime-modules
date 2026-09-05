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
Object.defineProperty(exports, "__esModule", { value: true });
exports.lobbyForChannel = lobbyForChannel;
exports.channelForLobby = channelForLobby;
/** `chat:dm:alice:bob` → `dm:alice:bob`; `room:design` → `room:design`. */
function lobbyForChannel(channel) {
    if (!channel)
        return null;
    if (channel.startsWith('chat:dm:'))
        return channel.slice('chat:'.length);
    if (channel.startsWith('room:'))
        return channel;
    // A plain channel (`general`) has no call lobby: calls are addressed to
    // people or to a room, and a bare channel is neither.
    return null;
}
/** `dm:alice:bob` → `chat:dm:alice:bob`; `room:design` → `room:design`. */
function channelForLobby(lobby) {
    if (!lobby)
        return null;
    if (lobby.startsWith('dm:'))
        return `chat:${lobby}`;
    if (lobby.startsWith('room:'))
        return lobby;
    return null;
}
//# sourceMappingURL=lobbyChannel.js.map