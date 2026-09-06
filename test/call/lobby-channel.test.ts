// The round trip is the point: whatever one direction produces, the other has
// to take back. A silent mismatch means a call posts into a thread nobody
// reads, or a thread lists no recordings for calls it definitely had.

import {
  lobbyForChannel,
  channelForLobby,
  isDmLobby,
  dmLobbyMembers,
  shouldKnockToJoin,
} from '../../src/call/lobbyChannel';

describe('lobby ↔ channel', () => {
  it('maps a DM conversation to its lobby and back', () => {
    expect(lobbyForChannel('chat:dm:alice:bob')).toBe('dm:alice:bob');
    expect(channelForLobby('dm:alice:bob')).toBe('chat:dm:alice:bob');
  });

  // A room is its own conversation — same string, both directions.
  it('leaves a room alone in both directions', () => {
    expect(lobbyForChannel('room:design')).toBe('room:design');
    expect(channelForLobby('room:design')).toBe('room:design');
  });

  // A multi-party DM is addressed by its members until that id would exceed
  // the 100-char channel cap, at which point it becomes a HASHED group. Both
  // are the same product concept, so both must map — handling only the first
  // meant a group silently lost calling once it grew past the cap.
  it('maps a multi-party DM', () => {
    expect(lobbyForChannel('chat:dm:alice:bob:carol')).toBe('dm:alice:bob:carol');
    expect(channelForLobby('dm:alice:bob:carol')).toBe('chat:dm:alice:bob:carol');
  });

  it('maps a HASHED group, which is what a big group chat becomes', () => {
    const hashed = 'chat:dmg:9f2c1a4b55de7788aa11bb22';
    expect(lobbyForChannel(hashed)).toBe('dmg:9f2c1a4b55de7788aa11bb22');
    expect(channelForLobby('dmg:9f2c1a4b55de7788aa11bb22')).toBe(hashed);
  });

  // `chat:dmg:` does not start with `chat:dm:` — the eighth character is 'g',
  // not ':'. Pinned so a future refactor cannot collapse the two prefixes and
  // hand a group the wrong lobby.
  it('does not treat a hashed group as a plain DM', () => {
    expect(lobbyForChannel('chat:dmg:abc')).not.toBe('dm:g:abc');
    expect(lobbyForChannel('chat:dmg:abc')).toBe('dmg:abc');
  });

  it('round-trips every channel that has a lobby', () => {
    for (const channel of ['chat:dm:alice:bob', 'chat:dm:a:b:c', 'chat:dmg:9f2c1a4b', 'room:design', 'room:a:b:c']) {
      expect(channelForLobby(lobbyForChannel(channel))).toBe(channel);
    }
  });

  it('round-trips every lobby that has a channel', () => {
    for (const lobby of ['dm:alice:bob', 'dm:a:b:c', 'dmg:9f2c1a4b', 'room:design']) {
      expect(lobbyForChannel(channelForLobby(lobby))).toBe(lobby);
    }
  });

  // Not a failure — calls are addressed to people or to a room, and a bare
  // channel is neither.
  it('answers null for a place with no counterpart', () => {
    expect(lobbyForChannel('general')).toBeNull();
    expect(channelForLobby('lobby-adhoc-123')).toBeNull();
    expect(lobbyForChannel(null)).toBeNull();
    expect(channelForLobby(undefined)).toBeNull();
    expect(lobbyForChannel('')).toBeNull();
  });

  // `chat:` alone is a chat channel, not a DM, and has no lobby.
  it('does not mistake a non-DM chat channel for a DM', () => {
    expect(lobbyForChannel('chat:general')).toBeNull();
  });
});

describe('isDmLobby', () => {
  it('accepts both dm lobby forms', () => {
    expect(isDmLobby('dm:alice:bob')).toBe(true);
    expect(isDmLobby('dm:alice:bob:carol')).toBe(true);
    expect(isDmLobby('dmg:9f2c14a7b3')).toBe(true);
  });

  // The whole reason this helper exists: a hand-rolled `startsWith('dm:')`
  // answers false here, and a group chat loses privacy gating the moment it
  // grows past the 100-char cap.
  it('does not lose the hashed group form', () => {
    const grown = channelForLobby('dmg:9f2c14a7b3');
    expect(lobbyForChannel(grown)).toBe('dmg:9f2c14a7b3');
    expect(isDmLobby(lobbyForChannel(grown))).toBe(true);
  });

  it('rejects rooms, ad-hoc lobbies and empties', () => {
    expect(isDmLobby('room:design')).toBe(false);
    expect(isDmLobby('global')).toBe(false);
    expect(isDmLobby('')).toBe(false);
    expect(isDmLobby(null)).toBe(false);
    expect(isDmLobby(undefined)).toBe(false);
  });
});

describe('dmLobbyMembers', () => {
  it('parses members from a member-addressed lobby', () => {
    expect(dmLobbyMembers('dm:alice:bob')).toEqual(['alice', 'bob']);
    expect(dmLobbyMembers('dm:alice:bob:carol')).toEqual(['alice', 'bob', 'carol']);
  });

  // Null here means "private, but this name cannot tell you who" — callers
  // must take the closed branch, NOT read it as "not a DM".
  it('returns null for a hashed group, which is still a DM', () => {
    expect(dmLobbyMembers('dmg:9f2c14a7b3')).toBeNull();
    expect(isDmLobby('dmg:9f2c14a7b3')).toBe(true);
  });

  it('returns null for non-dm and malformed lobbies', () => {
    expect(dmLobbyMembers('room:design')).toBeNull();
    expect(dmLobbyMembers('dm:alice')).toBeNull();
    expect(dmLobbyMembers(null)).toBeNull();
  });
});

describe('shouldKnockToJoin', () => {
  it('lets a party to the DM walk in', () => {
    expect(shouldKnockToJoin('dm:alice:bob', 'alice')).toBe(false);
    expect(shouldKnockToJoin('dm:alice:bob:carol', 'carol')).toBe(false);
  });

  it('makes an outsider knock', () => {
    expect(shouldKnockToJoin('dm:alice:bob', 'mallory')).toBe(true);
  });

  // The bug this whole pair was extracted from: members are not derivable
  // from a hash, and "not derivable" must not read as "not private".
  it('makes a hashed group knock rather than opening the door', () => {
    expect(shouldKnockToJoin('dmg:9f2c14a7b3', 'alice')).toBe(true);
  });

  it('never knocks for a room or an unidentified caller in public', () => {
    expect(shouldKnockToJoin('room:design', 'alice')).toBe(false);
    expect(shouldKnockToJoin('room:design', null)).toBe(false);
    expect(shouldKnockToJoin(null, 'alice')).toBe(false);
  });

  it('makes an unidentified caller knock at a private door', () => {
    expect(shouldKnockToJoin('dm:alice:bob', null)).toBe(true);
  });
});
