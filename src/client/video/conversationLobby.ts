// Lobby naming for conversation calls. A DM's call lobby is its members,
// sorted, so both sides' `findOrCreate` land on the same platform-api session
// whoever rings first. The prefix is the host's (a tenant, `acme:`) and is
// prepended verbatim — nothing here, and nothing in useConversationCall,
// rewrites a lobby name after that.

export { channelForLobby, lobbyForChannel, isDmLobby } from '../../call/lobbyChannel';

/**
 * `dmLobbyName(['bob', 'alice'])` → `dm:alice:bob`;
 * `dmLobbyName(['bob', 'alice'], { prefix: 'acme:' })` → `acme:dm:alice:bob`.
 * Duplicates and empty ids are dropped; include yourself in `userIds`.
 */
export function dmLobbyName(userIds: string[], opts: { prefix?: string } = {}): string {
  const ids = Array.from(new Set(userIds.filter((u) => typeof u === 'string' && u.length > 0))).sort();
  return `${opts.prefix ?? ''}dm:${ids.join(':')}`;
}
