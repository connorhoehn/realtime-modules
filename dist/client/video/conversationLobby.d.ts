export { channelForLobby, lobbyForChannel, isDmLobby } from '../../call/lobbyChannel';
/**
 * `dmLobbyName(['bob', 'alice'])` → `dm:alice:bob`;
 * `dmLobbyName(['bob', 'alice'], { prefix: 'acme:' })` → `acme:dm:alice:bob`.
 * Duplicates and empty ids are dropped; include yourself in `userIds`.
 * An id containing `:` throws: `:` separates the members, so `['a', 'b:c']`
 * and `['a:b', 'c']` would name the same lobby — two different calls, one
 * room — and the server's DM membership rule would read the wrong members.
 */
export declare function dmLobbyName(userIds: string[], opts?: {
    prefix?: string;
}): string;
//# sourceMappingURL=conversationLobby.d.ts.map