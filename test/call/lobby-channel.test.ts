// The round trip is the point: whatever one direction produces, the other has
// to take back. A silent mismatch means a call posts into a thread nobody
// reads, or a thread lists no recordings for calls it definitely had.

import { lobbyForChannel, channelForLobby } from '../../src/call/lobbyChannel';

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
