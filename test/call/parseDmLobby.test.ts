// 0.109: one parser for DM lobby names, so hosts stop slicing sample names.
import { dmLobbyName, dmLobbyPrefix, parseDmLobby, dmLobbyMembers } from '../../src/call';
import * as video from '../../src/client/video';

describe('dmLobbyPrefix', () => {
    it('is the prefix dmLobbyName writes, with and without a tenant prefix', () => {
        expect(dmLobbyPrefix()).toBe('dm:');
        expect(dmLobbyPrefix({ prefix: 'social:' })).toBe('social:dm:');
        expect(dmLobbyPrefix({ group: true })).toBe('dmg:');
        expect(dmLobbyPrefix({ prefix: 'social:', group: true })).toBe('social:dmg:');
        expect(dmLobbyName(['b', 'a'], { prefix: 'social:' }).startsWith(dmLobbyPrefix({ prefix: 'social:' }))).toBe(true);
        expect(dmLobbyName(['b', 'a']).startsWith(dmLobbyPrefix())).toBe(true);
    });
});

describe('parseDmLobby', () => {
    it('dm: without a tenant prefix', () => {
        expect(parseDmLobby('dm:alice:bob')).toEqual({ kind: 'dm', prefix: '', members: ['alice', 'bob'] });
        expect(parseDmLobby('dm:alice:bob', { prefix: '' })).toEqual({ kind: 'dm', prefix: '', members: ['alice', 'bob'] });
        expect(parseDmLobby('dm:a:b:c')).toEqual({ kind: 'dm', prefix: '', members: ['a', 'b', 'c'] });
    });

    it('dm: with a tenant prefix, explicit or read from the name', () => {
        const name = dmLobbyName(['bob', 'alice'], { prefix: 'social:' });
        expect(parseDmLobby(name, { prefix: 'social:' })).toEqual({ kind: 'dm', prefix: 'social:', members: ['alice', 'bob'] });
        expect(parseDmLobby(name)).toEqual({ kind: 'dm', prefix: 'social:', members: ['alice', 'bob'] });
        expect(parseDmLobby('acme:eu:dm:a:b')).toEqual({ kind: 'dm', prefix: 'acme:eu:', members: ['a', 'b'] });
        // Members agree with the existing reader.
        expect(parseDmLobby(name)!).toMatchObject({ members: dmLobbyMembers(name) });
    });

    it('dmg: without and with a tenant prefix', () => {
        expect(parseDmLobby('dmg:0123abcd')).toEqual({ kind: 'dmg', prefix: '', hash: '0123abcd' });
        expect(parseDmLobby('dmg:0123abcd', { prefix: '' })).toEqual({ kind: 'dmg', prefix: '', hash: '0123abcd' });
        expect(parseDmLobby('social:dmg:0123abcd', { prefix: 'social:' })).toEqual({ kind: 'dmg', prefix: 'social:', hash: '0123abcd' });
        expect(parseDmLobby('social:dmg:0123abcd')).toEqual({ kind: 'dmg', prefix: 'social:', hash: '0123abcd' });
    });

    it('an explicit prefix must match exactly', () => {
        expect(parseDmLobby('assessment:dm:a:b', { prefix: 'social:' })).toBeNull();
        expect(parseDmLobby('social:dm:a:b', { prefix: '' })).toBeNull();
        expect(parseDmLobby('dm:a:b', { prefix: 'social:' })).toBeNull();
        expect(parseDmLobby('social:x:dm:a:b', { prefix: 'social:' })).toBeNull();
        expect(parseDmLobby('social:dmg:h', { prefix: 'social:x:' })).toBeNull();
    });

    it('refuses rooms, channels and malformed DMs', () => {
        for (const bad of [null, undefined, '', 'room:design', 'social:room:design', 'social:ch:general', 'dm:', 'dm:alice',
            'social:dm:alice', 'dm:alice::bob', 'dm:alice:', 'dmg:', 'social:dmg:', 'dmx:a:b', 'chat:general']) {
            expect(parseDmLobby(bad)).toBeNull();
            expect(parseDmLobby(bad, { prefix: 'social:' })).toBeNull();
        }
        expect(parseDmLobby('acme:room:dm-sync')).toBeNull();
        expect(parseDmLobby('dmg:a:b', { prefix: '' })).toBeNull();
    });

    it('ships from /client/video too', () => {
        expect(video.parseDmLobby('social:dm:a:b', { prefix: 'social:' })).toEqual({ kind: 'dm', prefix: 'social:', members: ['a', 'b'] });
        expect(video.dmLobbyPrefix({ prefix: 'social:' })).toBe('social:dm:');
    });
});
