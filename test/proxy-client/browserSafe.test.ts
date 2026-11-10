// realtime-modules/test/proxy-client/browserSafe.test.ts
//
// 0.147.0 regression: ./proxy-client imported @connorhoehn/service-runtime
// (Node-only, async_hooks) at module load, and every browser app that imports
// it rendered blank. These tests keep browser entries free of Node imports and
// keep server-side signing working.

import { spawnSync } from 'child_process';
import * as path from 'path';
import { verifyServiceRequest } from '@connorhoehn/service-runtime';

const ROOT = path.resolve(__dirname, '../..');
const SECRET = 'browser-safe-test-secret-0123456789abcdef';
const CLIENT_ID = 'test-server-app';

function okFetch(calls: Array<{ url: string; headers: Record<string, string> }>): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
}

describe('browser-safe client entries', () => {
    it('every client-facing subpath bundles for the browser without Node-only imports', () => {
        const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/verify-browser-safe.mjs'), '--src'], {
            cwd: ROOT,
            encoding: 'utf8',
        });
        if (run.status !== 0) throw new Error(`verify-browser-safe failed:\n${run.stdout}\n${run.stderr}`);
        expect(run.stdout).toContain('./proxy-client');
    }, 120_000);
});

describe('proxy-client without a signing secret', () => {
    afterEach(() => {
        jest.resetModules();
        jest.dontMock('@connorhoehn/service-runtime');
    });

    it('never loads service-runtime', async () => {
        jest.doMock('@connorhoehn/service-runtime', () => {
            throw new Error('service-runtime must not load without a signing secret');
        });
        const { GatewayProxyClient } = await import('../../src/proxy-client');
        const calls: Array<{ url: string; headers: Record<string, string> }> = [];
        const client = new GatewayProxyClient({ gatewayUrl: 'https://gw.example.com', fetch: okFetch(calls) });
        await client.getHealth();
        expect(calls).toHaveLength(1);
        expect(Object.keys(calls[0].headers).map((k) => k.toLowerCase())).not.toContain('x-service-auth');
    });

    it('a signing secret where service-runtime cannot load fails at construction with a clear error', async () => {
        jest.doMock('@connorhoehn/service-runtime', () => {
            throw new Error('not available in this runtime');
        });
        const { GatewayProxyClient } = await import('../../src/proxy-client');
        expect(
            () =>
                new GatewayProxyClient({
                    gatewayUrl: 'https://gw.example.com',
                    fetch: okFetch([]),
                    serviceAuthSecret: SECRET,
                    serviceAuthClientId: CLIENT_ID,
                }),
        ).toThrow(/request signing needs the service-runtime package/);
    });
});

describe('proxy-client/server', () => {
    it('exports the client and signs request-bound envelopes', async () => {
        const server = await import('../../src/proxy-client/server');
        const calls: Array<{ url: string; headers: Record<string, string> }> = [];
        const client = new server.GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: okFetch(calls),
            serviceAuthSecret: SECRET,
            serviceAuthClientId: CLIENT_ID,
        });
        await client.getHealth();
        const header = Object.entries(calls[0].headers).find(([k]) => k.toLowerCase() === 'x-service-auth')?.[1];
        expect(header).toBeDefined();
        const verifyOpts = { secret: SECRET, allowedServices: [CLIENT_ID], audience: 'realtime-gateway' };
        expect(verifyServiceRequest(String(header), { method: 'GET', target: '/health' }, verifyOpts).ok).toBe(true);
        expect(server.ProxyClientHttpError).toBeDefined();
    });
});
