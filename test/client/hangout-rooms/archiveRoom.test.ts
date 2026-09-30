import { archiveRoom } from '../../../src/client/hangout-rooms/api';

// platform-api serves POST /api/rooms/:slug/archive (owner/admin soft-delete,
// hangoutRooms.ts). There is no DELETE /api/rooms/:slug; the library used to
// send one and every archive 404'd.
describe('archiveRoom hits the served route', () => {
  it('POSTs /api/rooms/:slug/archive with the bearer token and no body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    (globalThis as any).fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"ok":true,"slug":"design team"}' } as any;
    };
    await archiveRoom({ baseUrl: 'http://api.test', getAuthToken: () => 'tok' }, 'design team');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://api.test/api/rooms/design%20team/archive');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
});
