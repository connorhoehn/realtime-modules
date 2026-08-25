/** Prefix of member-addressed dm chat channels (`chat:dm:a:b`). */
export declare const DM_CHANNEL_PREFIX = "chat:dm:";
/** Prefix of hashed group dm chat channels (`chat:dmg:<hash24>`). */
export declare const DM_GROUP_CHANNEL_PREFIX = "chat:dmg:";
/**
 * Cap on the member-addressed channel-name length. When the joined
 * `chat:dm:...` name would be LONGER than this, `dmChatChannelFor` falls
 * back to the hashed `chat:dmg:` form.
 */
export declare const DM_CHANNEL_NAME_MAX_LENGTH = 100;
/**
 * True for BOTH dm channel forms — member-addressed (`chat:dm:...`) and
 * hashed group (`chat:dmg:...`). Note the prefixes are disjoint:
 * `chat:dmg:x` does not start with `chat:dm:` (the 8th char is `g`, not
 * `:`), so the two startsWith checks never shadow each other.
 */
export declare function isDmChatChannel(channel: string): boolean;
/**
 * Canonical dm chat channel for a participant set.
 *
 *   - Sorts (lexicographic) + dedupes, so argument order never matters:
 *     `dmChatChannelFor(['b','a']) === dmChatChannelFor(['a','b'])`.
 *   - Validates: the array must be non-empty and every id must be a
 *     non-empty string WITHOUT `:` (a colon would corrupt the parse in
 *     `dmChannelMembers`). Throws on violation — channel naming is a
 *     programming-contract concern, not a runtime-recoverable one.
 *   - Length cap: if the joined `chat:dm:` name would exceed
 *     DM_CHANNEL_NAME_MAX_LENGTH, returns the hashed `chat:dmg:` form
 *     instead (deterministic, non-reversible — see module header).
 */
export declare function dmChatChannelFor(userIds: string[]): string;
/**
 * Parse the member userIds out of a member-addressed dm channel name.
 * Returns the ids in their canonical (sorted) on-wire order.
 *
 * Returns null when membership is NOT derivable from the name:
 *   - hashed group channels (`chat:dmg:` — non-reversible by design),
 *   - non-dm channels,
 *   - malformed member-addressed names (empty id segments).
 */
export declare function dmChannelMembers(channel: string): string[] | null;
//# sourceMappingURL=dmChannels.d.ts.map