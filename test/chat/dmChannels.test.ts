// realtime-modules/test/chat/dmChannels.test.ts
//
// v0.23.0 — dm channel naming helpers (pure functions, no service state).
//
//   chat:dm:<sorted userIds>   — member-addressed, membership parseable
//   chat:dmg:<sha1-hex[0..24)> — hashed group form when the joined name
//                                would exceed the 100-char cap; membership
//                                NON-reversible by design.

import { describe, it, expect } from '@jest/globals';
import {
    isDmChatChannel,
    dmChatChannelFor,
    dmChannelMembers,
    DM_CHANNEL_PREFIX,
    DM_GROUP_CHANNEL_PREFIX,
    DM_CHANNEL_NAME_MAX_LENGTH,
} from '../../dist/chat/dmChannels';

describe('dmChatChannelFor', () => {
    it('sorts userIds — argument order never matters (canonical name)', () => {
        expect(dmChatChannelFor(['dev-hank', 'dev-alice'])).toBe('chat:dm:dev-alice:dev-hank');
        expect(dmChatChannelFor(['dev-alice', 'dev-hank'])).toBe('chat:dm:dev-alice:dev-hank');
        expect(dmChatChannelFor(['c', 'a', 'b'])).toBe('chat:dm:a:b:c');
    });

    it('is sort-stable across repeated calls (deterministic)', () => {
        const perms = [
            ['x', 'y', 'z'],
            ['z', 'y', 'x'],
            ['y', 'x', 'z'],
        ];
        const names = perms.map((p) => dmChatChannelFor(p));
        expect(new Set(names).size).toBe(1);
    });

    it('dedupes repeated ids', () => {
        expect(dmChatChannelFor(['a', 'b', 'a'])).toBe('chat:dm:a:b');
    });

    it('validates: rejects empty array, empty ids, and ids containing ":"', () => {
        expect(() => dmChatChannelFor([])).toThrow(/non-empty array/);
        expect(() => dmChatChannelFor(['a', ''])).toThrow(/non-empty string/);
        expect(() => dmChatChannelFor(['a', 'b:c'])).toThrow(/may not contain ':'/);
    });

    it(`falls back to the hashed chat:dmg: form past ${DM_CHANNEL_NAME_MAX_LENGTH} chars`, () => {
        // 8 ids × 12 chars + separators pushes the joined name past 100.
        const ids = Array.from({ length: 8 }, (_, i) => `participant${i}x`.padEnd(12, 'p'));
        const channel = dmChatChannelFor(ids);
        expect(channel.startsWith(DM_GROUP_CHANNEL_PREFIX)).toBe(true);
        // prefix (9) + 24 hex chars
        expect(channel).toHaveLength(DM_GROUP_CHANNEL_PREFIX.length + 24);
        expect(channel.slice(DM_GROUP_CHANNEL_PREFIX.length)).toMatch(/^[0-9a-f]{24}$/);
    });

    it('hashed form is deterministic and order-independent, distinct per set', () => {
        const ids = Array.from({ length: 10 }, (_, i) => `member-with-long-id-${i}`);
        const a = dmChatChannelFor(ids);
        const b = dmChatChannelFor([...ids].reverse());
        expect(a).toBe(b);

        const other = dmChatChannelFor([...ids.slice(0, 9), 'member-with-long-id-99']);
        expect(other).not.toBe(a);
    });

    it('stays member-addressed at exactly the cap boundary', () => {
        // Construct a single id so that 'chat:dm:' + id is exactly 100 chars.
        const id = 'a'.repeat(DM_CHANNEL_NAME_MAX_LENGTH - DM_CHANNEL_PREFIX.length);
        const channel = dmChatChannelFor([id]);
        expect(channel).toBe(DM_CHANNEL_PREFIX + id);
        expect(channel).toHaveLength(DM_CHANNEL_NAME_MAX_LENGTH);
    });
});

describe('isDmChatChannel', () => {
    it('matches both dm forms and nothing else', () => {
        expect(isDmChatChannel('chat:dm:a:b')).toBe(true);
        expect(isDmChatChannel('chat:dmg:0123456789abcdef01234567')).toBe(true);
        expect(isDmChatChannel('chat:general')).toBe(false);
        expect(isDmChatChannel('dm:a:b')).toBe(false);
        expect(isDmChatChannel('chat:dmz:a')).toBe(false);
    });
});

describe('dmChannelMembers', () => {
    it('round-trips the member list from dmChatChannelFor', () => {
        expect(dmChannelMembers(dmChatChannelFor(['dev-hank', 'dev-alice']))).toEqual([
            'dev-alice',
            'dev-hank',
        ]);
        expect(dmChannelMembers(dmChatChannelFor(['c', 'a', 'b']))).toEqual(['a', 'b', 'c']);
    });

    it('returns null for hashed group channels (non-reversible by design)', () => {
        const ids = Array.from({ length: 10 }, (_, i) => `member-with-long-id-${i}`);
        const hashed = dmChatChannelFor(ids);
        expect(hashed.startsWith(DM_GROUP_CHANNEL_PREFIX)).toBe(true);
        expect(dmChannelMembers(hashed)).toBeNull();
    });

    it('returns null for non-dm and malformed channels', () => {
        expect(dmChannelMembers('chat:general')).toBeNull();
        expect(dmChannelMembers('chat:dm:')).toBeNull();
        expect(dmChannelMembers('chat:dm:a::b')).toBeNull();
    });
});
