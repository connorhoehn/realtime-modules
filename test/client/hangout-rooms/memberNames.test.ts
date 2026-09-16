import { addMember, removeMember } from '../../../src/client/hangout-rooms/api';

describe('room member names ride along', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const opts = { baseUrl: 'http://api.test', getAuthToken: () => 'tok' };
  beforeEach(() => {
    calls.length = 0;
    (globalThis as any).fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: init.method === 'DELETE' ? 204 : 201, json: async () => ({ userId: 'dev-carol', role: 'member' }), text: async () => '' } as any;
    };
  });

  it('addMember sends displayName and byName in the body', async () => {
    await addMember(opts, 'design', 'dev-carol', 'member', { displayName: 'Carol Johnson', byName: 'Eve Thompson' });
    expect(calls[0].url).toBe('http://api.test/api/rooms/design/members');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ userId: 'dev-carol', role: 'member', displayName: 'Carol Johnson', byName: 'Eve Thompson' });
  });

  it('addMember without names sends the old body', async () => {
    await addMember(opts, 'design', 'dev-carol');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ userId: 'dev-carol', role: 'member' });
  });

  it('removeMember puts the names on the query string', async () => {
    await removeMember(opts, 'design', 'dev-carol', { displayName: 'Carol Johnson', byName: 'Eve Thompson' });
    expect(calls[0].url).toBe('http://api.test/api/rooms/design/members/dev-carol?name=Carol+Johnson&byName=Eve+Thompson');
    expect(calls[0].init.method).toBe('DELETE');
  });
});
