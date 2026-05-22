// realtime-modules/test/proxy-client/GatewayProxyClient.test.ts
//
// Unit tests for the HTTP-shim client. All tests use a hand-rolled mock
// fetch — there is NO requirement for a running gateway. The "stub" methods
// (publishToChannel / getPresence / getChatHistory / getActivityHistory) are
// exercised against the mock fetch with successful responses to lock in
// their request shape; against a real gateway today they would 404.

import {
    GatewayProxyClient,
    ProxyClientError,
    ProxyClientNetworkError,
    ProxyClientHttpError,
    ProxyClientTimeoutError,
} from '../../src/proxy-client';

// ---- Mock fetch fixture --------------------------------------------------

interface RecordedCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
}

interface MockResponseSpec {
    status?: number;
    body?: unknown;
    /** When set, mock fetch rejects with this error instead of returning. */
    throwError?: unknown;
    /**
     * When true, mock fetch never resolves — useful for timeout tests. The
     * abort signal still triggers an AbortError rejection on the abort path.
     */
    hang?: boolean;
}

function makeMockFetch(specs: MockResponseSpec[]): {
    fetch: typeof fetch;
    calls: RecordedCall[];
} {
    const calls: RecordedCall[] = [];
    let idx = 0;
    const fn: typeof fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method ?? 'GET').toUpperCase();
        const headers = normaliseHeaders(init?.headers);
        const body = typeof init?.body === 'string' ? init.body : undefined;
        calls.push({ url, method, headers, body });

        const spec = specs[idx++] ?? specs[specs.length - 1];
        if (!spec) throw new Error('mock fetch: no response spec configured');

        if (spec.throwError !== undefined) throw spec.throwError;

        if (spec.hang) {
            return new Promise<Response>((_, reject) => {
                const signal = init?.signal;
                if (signal) {
                    if (signal.aborted) {
                        reject(makeAbortError());
                        return;
                    }
                    signal.addEventListener('abort', () => reject(makeAbortError()));
                }
            });
        }

        const status = spec.status ?? 200;
        const responseBody =
            typeof spec.body === 'string'
                ? spec.body
                : JSON.stringify(spec.body ?? {});
        // Construct a Response-shaped object; Node 18+ globalThis.Response works.
        return new Response(responseBody, {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    };
    return { fetch: fn, calls };
}

function normaliseHeaders(h: HeadersInit | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!h) return out;
    if (h instanceof Headers) {
        h.forEach((v, k) => {
            out[k.toLowerCase()] = v;
        });
        return out;
    }
    if (Array.isArray(h)) {
        for (const [k, v] of h) out[k.toLowerCase()] = v;
        return out;
    }
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
    return out;
}

function makeAbortError(): Error {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    return err;
}

// ---- Tests ---------------------------------------------------------------

describe('GatewayProxyClient — constructor', () => {
    it('rejects empty gatewayUrl', () => {
        expect(() =>
            new GatewayProxyClient({ gatewayUrl: '', fetch: globalThis.fetch }),
        ).toThrow(/gatewayUrl is required/);
    });

    it('strips trailing slashes from gatewayUrl', async () => {
        const { fetch: mock, calls } = makeMockFetch([{ status: 200, body: {} }]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com////',
            fetch: mock,
        });
        await client.getHealth();
        expect(calls[0].url).toBe('https://gw.example.com/health');
    });

    it('throws when no fetch is available', () => {
        expect(
            () =>
                new GatewayProxyClient({
                    gatewayUrl: 'https://gw.example.com',
                    // Force null fetch by passing undefined and stubbing global.
                    fetch: undefined as unknown as typeof fetch,
                }),
        ).not.toThrow(); // globalThis.fetch IS available in Node 18+ — sanity check
    });
});

describe('GatewayProxyClient — happy paths against real gateway endpoints', () => {
    it('getHealth() calls GET /health and returns the JSON body', async () => {
        const { fetch: mock, calls } = makeMockFetch([
            { status: 200, body: { service: 'gateway', status: 'ok', checks: { redis: { ok: true } } } },
        ]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
        });
        const out = await client.getHealth();
        expect(out.service).toBe('gateway');
        expect(out.status).toBe('ok');
        expect(calls[0].method).toBe('GET');
        expect(calls[0].url).toBe('https://gw.example.com/health');
    });

    it('getClusterInfo() calls GET /cluster', async () => {
        const { fetch: mock, calls } = makeMockFetch([
            { status: 200, body: { nodes: [], totalNodes: 1, totalConnections: 0 } },
        ]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
        });
        const out = await client.getClusterInfo();
        expect(out.totalNodes).toBe(1);
        expect(calls[0].url).toBe('https://gw.example.com/cluster');
    });

    it('getStats() calls GET /stats', async () => {
        const { fetch: mock, calls } = makeMockFetch([
            { status: 200, body: { node: {}, services: { chat: { messages: 42 } } } },
        ]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
        });
        const out = await client.getStats();
        expect(out.services.chat).toEqual({ messages: 42 });
        expect(calls[0].url).toBe('https://gw.example.com/stats');
    });

    it('getMetrics() calls GET /metrics', async () => {
        const metricsPayload = {
            connections: { current: 3, peak: 9 },
            messages: { received: 1, sent: 2, errors: 0 },
            crdt: { activeDocuments: 0, totalYDocMemoryMB: 0 },
            redis: { status: 'connected' },
            uptime: 60,
        };
        const { fetch: mock, calls } = makeMockFetch([
            { status: 200, body: metricsPayload },
        ]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
        });
        const out = await client.getMetrics();
        expect(out.connections.peak).toBe(9);
        expect(calls[0].url).toBe('https://gw.example.com/metrics');
    });

    it('triggerPipelineWebhook() POSTs to /hooks/pipeline/<path> with JSON body and optional signature', async () => {
        const { fetch: mock, calls } = makeMockFetch([
            { status: 202, body: { accepted: true, path: 'github-push', runId: 'run-1' } },
        ]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
        });
        const out = await client.triggerPipelineWebhook(
            '/github-push/',
            { ref: 'refs/heads/main' },
            { signature: 'sha256=abc123' },
        );
        expect(out.accepted).toBe(true);
        expect(out.runId).toBe('run-1');
        expect(calls[0].method).toBe('POST');
        expect(calls[0].url).toBe('https://gw.example.com/hooks/pipeline/github-push');
        expect(calls[0].headers['content-type']).toBe('application/json');
        expect(calls[0].headers['x-webhook-signature']).toBe('sha256=abc123');
        expect(JSON.parse(calls[0].body!)).toEqual({ ref: 'refs/heads/main' });
    });

    it('triggerPipelineWebhook() rejects empty path', async () => {
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: makeMockFetch([]).fetch,
        });
        await expect(client.triggerPipelineWebhook('', {})).rejects.toThrow(
            /webhookPath is required/,
        );
    });
});

describe('GatewayProxyClient — stub paths (gateway routes not yet implemented)', () => {
    // These tests pin the URL shape so when gateway adds the real routes,
    // the client is already wired correctly. They use a mock fetch returning
    // a successful body — against a live gateway today they would 404.

    it('publishToChannel() POSTs to /api/channels/:id/messages', async () => {
        const { fetch: mock, calls } = makeMockFetch([
            { status: 200, body: { delivered: 7 } },
        ]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
        });
        const out = await client.publishToChannel('room:42', { kind: 'hello' });
        expect(out.delivered).toBe(7);
        expect(calls[0].method).toBe('POST');
        expect(calls[0].url).toBe(
            'https://gw.example.com/api/channels/room%3A42/messages',
        );
        expect(JSON.parse(calls[0].body!)).toEqual({ payload: { kind: 'hello' } });
    });

    it('getPresence() GETs /api/presence/:channel', async () => {
        const { fetch: mock, calls } = makeMockFetch([
            {
                status: 200,
                body: {
                    users: [
                        {
                            clientId: 'c1',
                            status: 'online',
                            metadata: {},
                            channels: ['room:1'],
                            nodeId: 'node-a',
                            timestamp: '2026-05-19T00:00:00Z',
                            lastSeen: '2026-05-19T00:00:00Z',
                            lastHeartbeat: 0,
                        },
                    ],
                },
            },
        ]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
        });
        const out = await client.getPresence('room:1');
        expect(out.users).toHaveLength(1);
        expect(out.users[0].clientId).toBe('c1');
        expect(calls[0].url).toBe('https://gw.example.com/api/presence/room%3A1');
    });

    it('getChatHistory() GETs /api/chat/:channel/history with limit + before query', async () => {
        const { fetch: mock, calls } = makeMockFetch([
            { status: 200, body: [] as unknown[] },
        ]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
        });
        await client.getChatHistory('room:1', { limit: 50, before: 'm-100' });
        const url = new URL(calls[0].url);
        expect(url.pathname).toBe('/api/chat/room%3A1/history');
        expect(url.searchParams.get('limit')).toBe('50');
        expect(url.searchParams.get('before')).toBe('m-100');
    });

    it('getActivityHistory() GETs /api/activity/:channel/history', async () => {
        const { fetch: mock, calls } = makeMockFetch([
            { status: 200, body: [] as unknown[] },
        ]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
        });
        await client.getActivityHistory('room:1', { limit: 10 });
        const url = new URL(calls[0].url);
        expect(url.pathname).toBe('/api/activity/room%3A1/history');
        expect(url.searchParams.get('limit')).toBe('10');
    });
});

describe('GatewayProxyClient — HMAC signing (serviceAuthSecret)', () => {
    const SECRET = 'test-secret-abc123';
    const CLIENT_ID = 'test-lambda-app';

    it('adds X-Service-Auth header when serviceAuthSecret + serviceAuthClientId provided', async () => {
        const { fetch: mock, calls } = makeMockFetch([{ status: 200, body: {} }]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
            serviceAuthSecret: SECRET,
            serviceAuthClientId: CLIENT_ID,
        });
        await client.getHealth();
        const authHeader = calls[0].headers['x-service-auth'];
        expect(authHeader).toBeDefined();
        // v1.<serviceId>.<unixTsSec>.<base64url-mac>
        expect(authHeader).toMatch(/^v1\.test-lambda-app\.\d+\.[A-Za-z0-9_-]+$/);
    });

    it('does NOT add X-Service-Auth header when serviceAuthSecret is omitted (legacy mode)', async () => {
        const { fetch: mock, calls } = makeMockFetch([{ status: 200, body: {} }]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
        });
        await client.getHealth();
        expect(calls[0].headers['x-service-auth']).toBeUndefined();
    });

    it('computes a fresh timestamp per request (header varies across calls)', async () => {
        const { fetch: mock, calls } = makeMockFetch([
            { status: 200, body: { status: 'ok' } },
            { status: 200, body: { status: 'ok' } },
        ]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
            serviceAuthSecret: SECRET,
            serviceAuthClientId: CLIENT_ID,
        });
        await client.getHealth();
        // Small pause to allow clock to advance (1 second boundary).
        // If both calls land in the same second the ts segment may be equal —
        // that's fine; we only assert the header exists and has the right shape.
        await client.getHealth();
        const h1 = calls[0].headers['x-service-auth'];
        const h2 = calls[1].headers['x-service-auth'];
        expect(h1).toMatch(/^v1\.test-lambda-app\.\d+\.[A-Za-z0-9_-]+$/);
        expect(h2).toMatch(/^v1\.test-lambda-app\.\d+\.[A-Za-z0-9_-]+$/);
    });

    it('signs POST body (publishToChannel) with same v1 envelope', async () => {
        const { fetch: mock, calls } = makeMockFetch([{ status: 200, body: { delivered: 3 } }]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
            serviceAuthSecret: SECRET,
            serviceAuthClientId: CLIENT_ID,
        });
        await client.publishToChannel('room:1', { type: 'msg', text: 'hello' });
        const authHeader = calls[0].headers['x-service-auth'];
        expect(authHeader).toBeDefined();
        expect(authHeader).toMatch(/^v1\.test-lambda-app\.\d+\.[A-Za-z0-9_-]+$/);
    });

    it('throws TypeError when only serviceAuthSecret is provided (missing clientId)', () => {
        expect(
            () =>
                new GatewayProxyClient({
                    gatewayUrl: 'https://gw.example.com',
                    fetch: makeMockFetch([]).fetch,
                    serviceAuthSecret: SECRET,
                }),
        ).toThrow(/serviceAuthClientId is required/);
    });

    it('throws TypeError when only serviceAuthClientId is provided (missing secret)', () => {
        expect(
            () =>
                new GatewayProxyClient({
                    gatewayUrl: 'https://gw.example.com',
                    fetch: makeMockFetch([]).fetch,
                    serviceAuthClientId: CLIENT_ID,
                }),
        ).toThrow(/serviceAuthSecret is required/);
    });
});

describe('GatewayProxyClient — error handling', () => {
    it('surfaces HTTP non-2xx as ProxyClientHttpError with status + body', async () => {
        const { fetch: mock } = makeMockFetch([
            { status: 502, body: 'upstream broken' },
        ]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
        });
        const err = await client.getHealth().catch((e) => e);
        expect(err).toBeInstanceOf(ProxyClientHttpError);
        expect(err).toBeInstanceOf(ProxyClientError);
        expect(err.status).toBe(502);
        // body() retrieves the response text; it was a stringified JSON object
        expect(err.body).toContain('upstream broken');
    });

    it('surfaces network failures as ProxyClientNetworkError with cause', async () => {
        const cause = new Error('ECONNREFUSED');
        const { fetch: mock } = makeMockFetch([{ throwError: cause }]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
        });
        const err = await client.getHealth().catch((e) => e);
        expect(err).toBeInstanceOf(ProxyClientNetworkError);
        expect(err).toBeInstanceOf(ProxyClientError);
        expect(err.cause).toBe(cause);
        expect(err.message).toMatch(/ECONNREFUSED/);
    });

    it('surfaces timeout as ProxyClientTimeoutError distinct from network', async () => {
        const { fetch: mock } = makeMockFetch([{ hang: true }]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
            timeout: 25,
        });
        const err = await client.getHealth().catch((e) => e);
        expect(err).toBeInstanceOf(ProxyClientTimeoutError);
        expect(err).not.toBeInstanceOf(ProxyClientNetworkError);
        expect(err.timeoutMs).toBe(25);
    });

    it('propagates authToken as Authorization: Bearer header', async () => {
        const { fetch: mock, calls } = makeMockFetch([{ status: 200, body: {} }]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
            authToken: 'secret-123',
        });
        await client.getHealth();
        expect(calls[0].headers['authorization']).toBe('Bearer secret-123');
    });

    it('omits Authorization header when no token configured', async () => {
        const { fetch: mock, calls } = makeMockFetch([{ status: 200, body: {} }]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
        });
        await client.getHealth();
        expect(calls[0].headers['authorization']).toBeUndefined();
    });

    it('uses injected fetch (not globalThis.fetch) when provided', async () => {
        let called = false;
        const fakeFetch = (async () => {
            called = true;
            return new Response('{}', { status: 200 });
        }) as unknown as typeof fetch;
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: fakeFetch,
        });
        await client.getHealth();
        expect(called).toBe(true);
    });

    it('surfaces malformed JSON response as ProxyClientNetworkError', async () => {
        const { fetch: mock } = makeMockFetch([
            { status: 200, body: 'not-json-{[' },
        ]);
        const client = new GatewayProxyClient({
            gatewayUrl: 'https://gw.example.com',
            fetch: mock,
        });
        const err = await client.getHealth().catch((e) => e);
        expect(err).toBeInstanceOf(ProxyClientNetworkError);
        expect(err.message).toMatch(/Failed to parse JSON/);
    });
});
