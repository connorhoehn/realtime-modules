"use strict";
// Lobby naming for conversation calls. A DM's call lobby is its members,
// sorted, so both sides' `findOrCreate` land on the same platform-api session
// whoever rings first. The prefix is the host's (a tenant, `acme:`) and is
// prepended verbatim — nothing here, and nothing in useConversationCall,
// rewrites a lobby name after that.
Object.defineProperty(exports, "__esModule", { value: true });
exports.dmLobbyName = exports.isDmLobby = exports.lobbyForChannel = exports.channelForLobby = void 0;
var lobbyChannel_1 = require("../../call/lobbyChannel");
Object.defineProperty(exports, "channelForLobby", { enumerable: true, get: function () { return lobbyChannel_1.channelForLobby; } });
Object.defineProperty(exports, "lobbyForChannel", { enumerable: true, get: function () { return lobbyChannel_1.lobbyForChannel; } });
Object.defineProperty(exports, "isDmLobby", { enumerable: true, get: function () { return lobbyChannel_1.isDmLobby; } });
Object.defineProperty(exports, "dmLobbyName", { enumerable: true, get: function () { return lobbyChannel_1.dmLobbyName; } });
//# sourceMappingURL=conversationLobby.js.map