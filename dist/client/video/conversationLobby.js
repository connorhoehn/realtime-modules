"use strict";
// Lobby naming for conversation calls. A DM's call lobby is its members,
// sorted, so both sides' `findOrCreate` land on the same platform-api session
// whoever rings first. The prefix is the host's (a tenant, `acme:`) and is
// prepended verbatim — nothing here, and nothing in useConversationCall,
// rewrites a lobby name after that.
Object.defineProperty(exports, "__esModule", { value: true });
exports.lobbyForCallLobbyChannel = exports.callLobbyChannel = exports.CALL_LOBBY_CHANNEL_PREFIX = exports.parseDmLobby = exports.dmLobbyPrefix = exports.dmLobbyName = exports.isDmLobby = exports.lobbyForChannel = exports.channelForLobby = void 0;
var lobbyChannel_1 = require("../../call/lobbyChannel");
Object.defineProperty(exports, "channelForLobby", { enumerable: true, get: function () { return lobbyChannel_1.channelForLobby; } });
Object.defineProperty(exports, "lobbyForChannel", { enumerable: true, get: function () { return lobbyChannel_1.lobbyForChannel; } });
Object.defineProperty(exports, "isDmLobby", { enumerable: true, get: function () { return lobbyChannel_1.isDmLobby; } });
Object.defineProperty(exports, "dmLobbyName", { enumerable: true, get: function () { return lobbyChannel_1.dmLobbyName; } });
Object.defineProperty(exports, "dmLobbyPrefix", { enumerable: true, get: function () { return lobbyChannel_1.dmLobbyPrefix; } });
Object.defineProperty(exports, "parseDmLobby", { enumerable: true, get: function () { return lobbyChannel_1.parseDmLobby; } });
Object.defineProperty(exports, "CALL_LOBBY_CHANNEL_PREFIX", { enumerable: true, get: function () { return lobbyChannel_1.CALL_LOBBY_CHANNEL_PREFIX; } });
Object.defineProperty(exports, "callLobbyChannel", { enumerable: true, get: function () { return lobbyChannel_1.callLobbyChannel; } });
Object.defineProperty(exports, "lobbyForCallLobbyChannel", { enumerable: true, get: function () { return lobbyChannel_1.lobbyForCallLobbyChannel; } });
//# sourceMappingURL=conversationLobby.js.map