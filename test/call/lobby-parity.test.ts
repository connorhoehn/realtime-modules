// baseChannel (/server) and the dm lobby helpers exported from /call.
// baseChannel's `chat:` half is lobbyForChatLobbyChannel, defined next to
// channelForLobby: these tests pin that every lobby channelForLobby wraps in
// `chat:` unwraps back, so the two cannot drift.

import {
  channelForLobby,
  dmLobbyMembers,
  dmLobbyName,
  lobbyForChatLobbyChannel,
} from '../../src/call/lobbyChannel';
import * as callExports from '../../src/call';
import { baseChannel, SERVICE_CHANNEL_PREFIXES } from '../../src/server-ws/channelAccess';
import * as serverExports from '../../src/server';
import { dmLobbyName as videoDmLobbyName } from '../../src/client/video/conversationLobby';

describe('baseChannel', () => {
  it('strips the chat: lobby form, read past a tenant prefix', () => {
    expect(baseChannel('chat:social:dm:a:b')).toBe('social:dm:a:b');
    expect(baseChannel('chat:dm:a:b')).toBe('dm:a:b');
    expect(baseChannel('chat:dmg:9f2c14a7b3')).toBe('dmg:9f2c14a7b3');
    expect(baseChannel('chat:acme:eu:dmg:9f2c')).toBe('acme:eu:dmg:9f2c');
  });

  it('strips the service prefixes', () => {
    expect(baseChannel('presence:social:ch:general')).toBe('social:ch:general');
    expect(baseChannel('reactions:acme:lobby')).toBe('acme:lobby');
    expect(baseChannel('cursor:acme:doc')).toBe('acme:doc');
    expect(baseChannel('presence:chat:social:dm:a:b')).toBe('social:dm:a:b');
  });

  it('does not map unrelated namespaces onto a tenant channel', () => {
    expect(baseChannel('activity:broadcast')).toBe('activity:broadcast');
    expect(baseChannel('chat:general')).toBe('chat:general');
    expect(baseChannel('chat:social:ch:general')).toBe('chat:social:ch:general');
    expect(baseChannel('chat:room:design')).toBe('chat:room:design');
    expect(baseChannel('pipeline:all')).toBe('pipeline:all');
    expect(baseChannel('social:ch:general')).toBe('social:ch:general');
  });

  it('keeps SERVICE_CHANNEL_PREFIXES service-only', () => {
    expect([...SERVICE_CHANNEL_PREFIXES]).toEqual(['presence', 'reactions', 'cursor']);
  });

  it('is exported from /server', () => {
    expect(serverExports.baseChannel).toBe(baseChannel);
  });

  it('unwraps every chat: channel channelForLobby produces', () => {
    for (const lobby of ['dm:a:b', 'dmg:abc123', 'dm:a:b:c']) {
      const channel = channelForLobby(lobby)!;
      expect(channel.startsWith('chat:')).toBe(true);
      expect(lobbyForChatLobbyChannel(channel)).toBe(lobby);
      expect(baseChannel(channel)).toBe(lobby);
    }
    // room lobbies are not wrapped, so there is nothing to unwrap.
    expect(channelForLobby('room:design')).toBe('room:design');
    expect(lobbyForChatLobbyChannel('room:design')).toBeNull();
  });
});

describe('dmLobbyName from /call', () => {
  it('is the same React-free function /client/video re-exports', () => {
    expect(callExports.dmLobbyName).toBe(dmLobbyName);
    expect(videoDmLobbyName).toBe(dmLobbyName);
    expect(dmLobbyName(['bob', 'alice'], { prefix: 'social:' })).toBe('social:dm:alice:bob');
    expect(dmLobbyMembers(dmLobbyName(['bob', 'alice'], { prefix: 'social:' }))).toEqual(['alice', 'bob']);
  });
});

describe('dmLobbyMembers on hashed groups', () => {
  it('stays null without a resolver (membership unknown, closed)', () => {
    expect(dmLobbyMembers('dmg:abc')).toBeNull();
    expect(dmLobbyMembers('social:dmg:abc')).toBeNull();
  });

  it('asks the host resolver and normalises its answer', () => {
    const resolveGroup = jest.fn((lobby: string) => (lobby === 'social:dmg:abc' ? ['carol', 'alice', 'bob', 'alice', ''] : null));
    expect(dmLobbyMembers('social:dmg:abc', { resolveGroup })).toEqual(['alice', 'bob', 'carol']);
    expect(dmLobbyMembers('social:dmg:zzz', { resolveGroup })).toBeNull();
    expect(dmLobbyMembers('dmg:x', { resolveGroup: () => { throw new Error('boom'); } })).toBeNull();
    expect(dmLobbyMembers('dmg:x', { resolveGroup: () => ['solo'] })).toBeNull();
    // A resolver never changes member-addressed or room answers.
    expect(dmLobbyMembers('dm:a:b', { resolveGroup: () => ['x', 'y'] })).toEqual(['a', 'b']);
    expect(dmLobbyMembers('room:x', { resolveGroup: () => ['x', 'y'] })).toBeNull();
  });
});
