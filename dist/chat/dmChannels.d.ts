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
 * Which DM form a channel is: `'dm'` (members in the name), `'dmg'` (hashed
 * group; members not derivable), or null for a channel that is not a DM.
 */
export declare function dmChannelKind(channel: string): 'dm' | 'dmg' | null;
/**
 * True for BOTH dm channel forms — member-addressed (`…:dm:a:b`) and hashed
 * group (`…:dmg:<hash>`), with or without a tenant prefix (0.146.0).
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
 * Parse the member userIds out of a member-addressed dm channel name (any
 * tenant prefix before the `dm` segment is skipped, 0.146.0).
 * Returns the ids in their canonical (sorted) on-wire order.
 *
 * Returns null when membership is NOT derivable from the name:
 *   - hashed group channels (`chat:dmg:` — non-reversible by design),
 *   - non-dm channels,
 *   - malformed member-addressed names (empty id segments).
 */
export declare function dmChannelMembers(channel: string): string[] | null;
//# sourceMappingURL=dmChannels.d.ts.map