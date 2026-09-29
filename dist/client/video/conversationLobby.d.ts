export { channelForLobby, lobbyForChannel, isDmLobby } from '../../call/lobbyChannel';
/**
 * `dmLobbyName(['bob', 'alice'])` → `dm:alice:bob`;
 * `dmLobbyName(['bob', 'alice'], { prefix: 'acme:' })` → `acme:dm:alice:bob`.
 * Duplicates and empty ids are dropped; include yourself in `userIds`.
 */
export declare function dmLobbyName(userIds: string[], opts?: {
    prefix?: string;
}): string;
//# sourceMappingURL=conversationLobby.d.ts.map