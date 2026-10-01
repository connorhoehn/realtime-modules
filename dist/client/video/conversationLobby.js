"use strict";
// Lobby naming for conversation calls. A DM's call lobby is its members,
// sorted, so both sides' `findOrCreate` land on the same platform-api session
// whoever rings first. The prefix is the host's (a tenant, `acme:`) and is
// prepended verbatim — nothing here, and nothing in useConversationCall,
// rewrites a lobby name after that.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDmLobby = exports.lobbyForChannel = exports.channelForLobby = void 0;
exports.dmLobbyName = dmLobbyName;
var lobbyChannel_1 = require("../../call/lobbyChannel");
Object.defineProperty(exports, "channelForLobby", { enumerable: true, get: function () { return lobbyChannel_1.channelForLobby; } });
Object.defineProperty(exports, "lobbyForChannel", { enumerable: true, get: function () { return lobbyChannel_1.lobbyForChannel; } });
Object.defineProperty(exports, "isDmLobby", { enumerable: true, get: function () { return lobbyChannel_1.isDmLobby; } });
/**
 * `dmLobbyName(['bob', 'alice'])` → `dm:alice:bob`;
 * `dmLobbyName(['bob', 'alice'], { prefix: 'acme:' })` → `acme:dm:alice:bob`.
 * Duplicates and empty ids are dropped; include yourself in `userIds`.
 * An id containing `:` throws: `:` separates the members, so `['a', 'b:c']`
 * and `['a:b', 'c']` would name the same lobby — two different calls, one
 * room — and the server's DM membership rule would read the wrong members.
 */
function dmLobbyName(userIds, opts = {}) {
    const ids = Array.from(new Set(userIds.filter((u) => typeof u === 'string' && u.length > 0))).sort();
    const bad = ids.find((u) => u.includes(':'));
    if (bad !== undefined)
        throw new Error(`dmLobbyName: user id ${JSON.stringify(bad)} contains ':', the lobby's member separator`);
    return `${opts.prefix ?? ''}dm:${ids.join(':')}`;
}
//# sourceMappingURL=conversationLobby.js.map