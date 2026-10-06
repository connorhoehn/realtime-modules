// Lobby naming for conversation calls. A DM's call lobby is its members,
// sorted, so both sides' `findOrCreate` land on the same platform-api session
// whoever rings first. The prefix is the host's (a tenant, `acme:`) and is
// prepended verbatim — nothing here, and nothing in useConversationCall,
// rewrites a lobby name after that.

export { channelForLobby, lobbyForChannel, isDmLobby, dmLobbyName } from '../../call/lobbyChannel';

