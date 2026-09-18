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

// Where the REST half lives. Deriving it from the socket URL is right for the
// common deployment and silently wrong for two that are not rare — and wrong
// in the way this whole surface keeps being wrong, since a misrouted call
// 404s and the hooks read 404 as "no endpoint here" and degrade quietly.
describe('createGatewayRest httpBase', () => {
    it('keeps a path prefix the socket URL carries, which derivation drops', async () => {
        // Derivation is origin-only: the /gateway prefix does not survive it.
        expect(httpBaseFromSocketUrl('wss://example.com/gateway/ws')).toBe('https://example.com');

        const fetchMock = mockFetch(() => ok({ enabled: true }));
        await createGatewayRest(
            'wss://example.com/gateway/ws',
            undefined,
            'https://example.com/gateway',
        )!.getCapability!('chat');

        expect(String(fetchMock.mock.calls[0]![0]))
            .toContain('https://example.com/gateway/api/capabilities');
    });

    it('routes to a separate REST origin', async () => {
        const fetchMock = mockFetch(() => ok({ pins: [] }));
        await createGatewayRest('wss://ws.example.com', undefined, 'https://api.example.com')!
            .listPins!('room:design');

        expect(String(fetchMock.mock.calls[0]![0]))
            .toMatch(/^https:\/\/api\.example\.com\/api\/chat\/pins/);
    });

    // '' is a real answer, not a missing one: a dev server proxying /api wants
    // page-relative requests, not an absolute URL back to the socket's port.
    it('treats an empty base as page-relative rather than as unset', async () => {
        const fetchMock = mockFetch(() => ok({ enabled: true }));
        await createGatewayRest('ws://localhost:4000', undefined, '')!.getCapability!('chat');

        expect(String(fetchMock.mock.calls[0]![0])).toMatch(/^\/api\/capabilities/);
    });

    it('still derives from the socket URL when no base is given', async () => {
        const fetchMock = mockFetch(() => ok({ enabled: true }));
        await createGatewayRest('ws://localhost:18080')!.getCapability!('chat');

        expect(String(fetchMock.mock.calls[0]![0])).toContain('http://localhost:18080/api/capabilities');
    });

    it('builds a shim from an explicit base even when the socket URL is unparseable', async () => {
        const fetchMock = mockFetch(() => ok({ enabled: true }));
        const rest = createGatewayRest('nonsense', undefined, 'https://api.example.com');
        expect(rest).not.toBeNull();
        await rest!.getCapability!('chat');
        expect(String(fetchMock.mock.calls[0]![0])).toContain('https://api.example.com/api/capabilities');
    });
});

// The same silent failure, one method over. useFeatureFlag has always called
// rest.getFeatureFlag — through an `unknown` cast, so nothing checked that the
// default shim implemented it. It did not, which meant every provider-mounted
// app took the defaultValue branch no matter what the gateway would have said.
describe('createGatewayRest().getFeatureFlag', () => {
    it('asks the gateway for the named flag, encoded into the path', async () => {
        const fetchMock = mockFetch(() => ok({ enabled: true }));
        await createGatewayRest('ws://localhost:18080')!.getFeatureFlag!('checkout/flow');

        expect(String(fetchMock.mock.calls[0]![0]))
            .toBe('http://localhost:18080/api/feature-flags/checkout%2Fflow');
    });

    it('carries the bearer token when one is configured', async () => {
        const fetchMock = mockFetch(() => ok({ enabled: true }));
        await createGatewayRest('ws://localhost:18080', 'tok-123')!.getFeatureFlag!('new-ui');
        expect((fetchMock.mock.calls[0]![1] as any).headers.Authorization).toBe('Bearer tok-123');
    });

    it('returns the variant and metadata, not just the boolean', async () => {
        mockFetch(() => ok({ enabled: true, variant: 'variant-a', metadata: { rollout: 25 } }));
        const out = await createGatewayRest('ws://localhost:18080')!.getFeatureFlag!('checkout-flow');
        expect(out).toEqual({ enabled: true, variant: 'variant-a', metadata: { rollout: 25 } });
    });

    // Same contract as getCapability: the hook reads `status` to tell "no
    // feature-flag route here" from a failure worth surfacing.
    it('attaches the status so 404 stays distinguishable from a real failure', async () => {
        mockFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));
        await expect(
            createGatewayRest('ws://localhost:18080')!.getFeatureFlag!('x'),
        ).rejects.toMatchObject({ status: 404 });

        mockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
        await expect(
            createGatewayRest('ws://localhost:18080')!.getFeatureFlag!('x'),
        ).rejects.toMatchObject({ status: 500 });
    });
});
