import { GatewayProxyClient } from '../../src/proxy-client';

it('GatewayProxyClient calls fetch without the client as `this`', async () => {
    const seen: unknown[] = [];
    const fetchFn = function (this: unknown) {
        seen.push(this);
        return Promise.resolve({ ok: true, status: 200, headers: new Headers(), text: async () => '{}', json: async () => ({}) } as never);
    };
    const client = new GatewayProxyClient({ gatewayUrl: 'http://gw.test', fetch: fetchFn as never } as never);
    await client.getHealth().catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).not.toBe(client);
});
