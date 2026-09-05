// realtime-modules/test/client/gateway-rest.test.ts
//
// The REST half of the gateway.
//
// This exists because of a silent failure that lasted as long as the feature
// did: `rest` was an undeclared extension point only Lambda-tier proxy clients
// wired in, so in every browser app the capability hooks found nothing to ask,
// took their optimistic fallback, and reported EVERY capability enabled. The
// gate was complete on both sides and never fired once. A default shim is what
// makes "declared ∩ provisioned" a real intersection rather than a diagram.

import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { httpBaseFromSocketUrl, createGatewayRest } from '../../src/client/GatewaySocketProvider';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockFetch(impl: (url: string, init?: any) => any) {
    const fn = jest.fn(async (url: any, init?: any) => impl(String(url), init));
    globalThis.fetch = fn as any;
    return fn;
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('httpBaseFromSocketUrl', () => {
    // The gateway serves REST on the same origin it accepts sockets on, so
    // the socket URL should be the only thing a consumer configures.
    it('maps ws to http and wss to https', () => {
        expect(httpBaseFromSocketUrl('ws://localhost:18080')).toBe('http://localhost:18080');
        expect(httpBaseFromSocketUrl('wss://gw.example.com')).toBe('https://gw.example.com');
    });

    it('keeps the port, which is the whole point locally', () => {
        expect(httpBaseFromSocketUrl('ws://localhost:18080/socket')).toBe('http://localhost:18080');
    });

    it('returns null for something that is not a URL', () => {
        expect(httpBaseFromSocketUrl('not a url')).toBeNull();
    });
});

describe('createGatewayRest', () => {
    it('asks the gateway about one capability on one channel', async () => {
        const fetchMock = mockFetch(() => ok({ enabled: true }));
        const rest = createGatewayRest('ws://localhost:18080')!;

        await rest.getCapability!('conversation.documents', 'chat:dm:a:b');

        const url = String(fetchMock.mock.calls[0]![0]);
        expect(url).toContain('http://localhost:18080/api/capabilities');
        expect(url).toContain('name=conversation.documents');
        // Encoded, because a channel id has colons in it.
        expect(url).toContain('channel=chat%3Adm%3Aa%3Ab');
    });

    it('omits the channel when there is none', async () => {
        const fetchMock = mockFetch(() => ok({ enabled: true }));
        await createGatewayRest('ws://localhost:18080')!.getCapability!('conversation.files');
        expect(String(fetchMock.mock.calls[0]![0])).not.toContain('channel=');
    });

    it('carries the bearer token when one is configured', async () => {
        const fetchMock = mockFetch(() => ok({ enabled: true }));
        await createGatewayRest('ws://localhost:18080', 'tok-123')!.getCapability!('x');
        expect((fetchMock.mock.calls[0]![1] as any).headers.Authorization).toBe('Bearer tok-123');
    });

    it('returns the verdict as the gateway gave it', async () => {
        mockFetch(() => ok({ enabled: false, metadata: { requires: ['crdt'] } }));
        const out = await createGatewayRest('ws://localhost:18080')!.getCapability!('conversation.documents');
        expect(out).toEqual({ enabled: false, metadata: { requires: ['crdt'] } });
    });

    // The hooks branch on `status === 404` to mean "this gateway has no
    // capability endpoint", which is the optimistic case rather than a
    // failure. Losing the status turns that into a hard error.
    it('attaches the status so 404 stays distinguishable from a real failure', async () => {
        mockFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));
        await expect(
            createGatewayRest('ws://localhost:18080')!.getCapability!('x'),
        ).rejects.toMatchObject({ status: 404 });

        mockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
        await expect(
            createGatewayRest('ws://localhost:18080')!.getCapability!('x'),
        ).rejects.toMatchObject({ status: 500 });
    });

    it('builds nothing from a URL it cannot parse', () => {
        expect(createGatewayRest('nonsense')).toBeNull();
    });
});
