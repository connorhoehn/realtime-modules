/** `chat:dm:alice:bob` → `dm:alice:bob`; `chat:dmg:<hash>` → `dmg:<hash>`;
 *  `room:design` → `room:design`. */
export declare function lobbyForChannel(channel: string | null | undefined): string | null;
/** `dm:alice:bob` → `chat:dm:alice:bob`; `dmg:<hash>` → `chat:dmg:<hash>`;
 *  `room:design` → `room:design`. */
export declare function channelForLobby(lobby: string | null | undefined): string | null;
//# sourceMappingURL=lobbyChannel.d.ts.map