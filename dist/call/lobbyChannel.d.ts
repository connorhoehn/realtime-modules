/** `chat:dm:alice:bob` → `dm:alice:bob`; `chat:dmg:<hash>` → `dmg:<hash>`;
 *  `room:design` → `room:design`. */
export declare function lobbyForChannel(channel: string | null | undefined): string | null;
/** `dm:alice:bob` → `chat:dm:alice:bob`; `dmg:<hash>` → `chat:dmg:<hash>`;
 *  `room:design` → `room:design`. */
export declare function channelForLobby(lobby: string | null | undefined): string | null;
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
export declare function isDmLobby(lobby: string | null | undefined): boolean;
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
export declare function dmLobbyMembers(lobby: string | null | undefined): string[] | null;
//# sourceMappingURL=lobbyChannel.d.ts.map