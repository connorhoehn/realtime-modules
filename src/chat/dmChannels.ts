// realtime-modules/src/chat/dmChannels.ts
//
// Pure helpers for DIRECT-MESSAGE chat channel naming (v0.23.0).
//
// Convention:
//
//   chat:dm:<idA>:<idB>[:<idC>...]     — member-addressed dm channel. The
//     ids are SORTED userIds (lexicographic), so any participant set maps
//     to exactly one canonical channel name and membership can be parsed
//     straight back out of the name (`dmChannelMembers`).
//
//   chat:dmg:<sha1-hex[0..24)>         — hashed GROUP dm channel, used when
//     the joined member-addressed name would exceed
//     DM_CHANNEL_NAME_MAX_LENGTH (multi-party threads with many/long ids).
//     The hash is sha1 over the sorted ids joined with ':'. It is
//     deterministic (same participant set → same channel) but
//     NON-REVERSIBLE: membership CANNOT be parsed from the name —
//     `dmChannelMembers` returns null and consumers must resolve the
//     member list from their own conversations index (the gateway keeps
//     one via ChatService's `onDmMessage` seam).
//
// Everything here is pure — no service state, no I/O — so both the
// ChatService enforcement path and consumer repos (gateway REST routes,
// clients composing channel names) can share it.

import { createHash } from 'node:crypto';

/** Prefix of member-addressed dm chat channels (`chat:dm:a:b`). */
export const DM_CHANNEL_PREFIX = 'chat:dm:';

/** Prefix of hashed group dm chat channels (`chat:dmg:<hash24>`). */
export const DM_GROUP_CHANNEL_PREFIX = 'chat:dmg:';

/**
 * Cap on the member-addressed channel-name length. When the joined
 * `chat:dm:...` name would be LONGER than this, `dmChatChannelFor` falls
 * back to the hashed `chat:dmg:` form.
 */
export const DM_CHANNEL_NAME_MAX_LENGTH = 100;

/** Hex chars of the sha1 kept in the hashed group-channel name. */
const DM_GROUP_HASH_LENGTH = 24;

/**
 * True for BOTH dm channel forms — member-addressed (`chat:dm:...`) and
 * hashed group (`chat:dmg:...`). Note the prefixes are disjoint:
 * `chat:dmg:x` does not start with `chat:dm:` (the 8th char is `g`, not
 * `:`), so the two startsWith checks never shadow each other.
 */
export function isDmChatChannel(channel: string): boolean {
    return (
        typeof channel === 'string' &&
        (channel.startsWith(DM_CHANNEL_PREFIX) || channel.startsWith(DM_GROUP_CHANNEL_PREFIX))
    );
}

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
export function dmChatChannelFor(userIds: string[]): string {
    if (!Array.isArray(userIds) || userIds.length === 0) {
        throw new Error('dmChatChannelFor: userIds must be a non-empty array');
    }
    for (const id of userIds) {
        if (typeof id !== 'string' || id.length === 0) {
            throw new Error('dmChatChannelFor: every userId must be a non-empty string');
        }
        if (id.includes(':')) {
            throw new Error(`dmChatChannelFor: userId may not contain ':' (got ${JSON.stringify(id)})`);
        }
    }

    const sorted = Array.from(new Set(userIds)).sort();
    const joined = sorted.join(':');
    const direct = DM_CHANNEL_PREFIX + joined;
    if (direct.length <= DM_CHANNEL_NAME_MAX_LENGTH) {
        return direct;
    }

    const hash = createHash('sha1').update(joined).digest('hex').slice(0, DM_GROUP_HASH_LENGTH);
    return DM_GROUP_CHANNEL_PREFIX + hash;
}

/**
 * Parse the member userIds out of a member-addressed dm channel name.
 * Returns the ids in their canonical (sorted) on-wire order.
 *
 * Returns null when membership is NOT derivable from the name:
 *   - hashed group channels (`chat:dmg:` — non-reversible by design),
 *   - non-dm channels,
 *   - malformed member-addressed names (empty id segments).
 */
export function dmChannelMembers(channel: string): string[] | null {
    if (typeof channel !== 'string' || !channel.startsWith(DM_CHANNEL_PREFIX)) {
        return null;
    }
    const rest = channel.slice(DM_CHANNEL_PREFIX.length);
    if (rest.length === 0) return null;
    const members = rest.split(':');
    if (members.some((m) => m.length === 0)) return null;
    return members;
}
