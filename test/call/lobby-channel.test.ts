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

  it('round-trips every channel that has a lobby', () => {
    for (const channel of ['chat:dm:alice:bob', 'room:design', 'room:a:b:c']) {
      expect(channelForLobby(lobbyForChannel(channel))).toBe(channel);
    }
  });

  it('round-trips every lobby that has a channel', () => {
    for (const lobby of ['dm:alice:bob', 'room:design']) {
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
