/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useAttachmentSrc.test.tsx
//
// The hook fetches image attachments with the viewer's bearer token. The
// attachment URL comes from whoever sent the message, so the token may only
// go to the gateway's own download route: a same-origin URL or a bare
// `/api/uploads/` path (plus origins the host names in `trustedOrigins`).
// Anything else is fetched without the header.

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react';
import { useAttachmentSrc } from '../../src/client/useAttachmentSrc';

type FetchCall = { url: string; headers: Record<string, string> };

let calls: FetchCall[] = [];
const realFetch = (globalThis as any).fetch;
const realCreate = (URL as any).createObjectURL;
const realRevoke = (URL as any).revokeObjectURL;

beforeEach(() => {
    calls = [];
    (globalThis as any).fetch = jest.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url, headers: { ...(init?.headers ?? {}) } });
        return { ok: true, status: 200, blob: async () => new Blob(['x']) } as any;
    });
    (URL as any).createObjectURL = jest.fn(() => 'blob:fake');
    (URL as any).revokeObjectURL = jest.fn();
});

afterEach(() => {
    (globalThis as any).fetch = realFetch;
    (URL as any).createObjectURL = realCreate;
    (URL as any).revokeObjectURL = realRevoke;
});

function fetchFor(url: string, opts: { trustedOrigins?: string[] } = {}): Promise<FetchCall> {
    const { result } = renderHook(() => useAttachmentSrc({ getToken: () => 'secret-token', ...opts }));
    result.current.srcFor({ id: `a-${url}`, url, contentType: 'image/png' });
    return waitFor(() => {
        const call = calls.find((c) => c.url === url);
        if (!call) throw new Error('not fetched yet');
        return call;
    });
}

describe('useAttachmentSrc — where the bearer token may go', () => {
    it('fetches an external attachment with no Authorization header', async () => {
        const call = await fetchFor('https://evil.example/x.png');
        expect(call.headers.Authorization).toBeUndefined();
        expect(Object.keys(call.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    });

    it('sends the token to a bare /api/uploads/ path', async () => {
        const call = await fetchFor('/api/uploads/abc-123');
        expect(call.headers.Authorization).toBe('Bearer secret-token');
    });

    it('sends the token to a same-origin URL', async () => {
        const call = await fetchFor(`${window.location.origin}/api/uploads/abc-123`);
        expect(call.headers.Authorization).toBe('Bearer secret-token');
    });

    it('does not treat a protocol-relative URL as a bare path', async () => {
        const call = await fetchFor('//evil.example/api/uploads/abc');
        expect(call.headers.Authorization).toBeUndefined();
    });

    it('does not send the token to a lookalike origin', async () => {
        const call = await fetchFor(`${window.location.origin}.evil.example/api/uploads/abc`);
        expect(call.headers.Authorization).toBeUndefined();
    });

    it('sends the token to an origin the host trusts explicitly, on the upload route only', async () => {
        const trusted = await fetchFor('https://gateway.example/api/uploads/abc', { trustedOrigins: ['https://gateway.example'] });
        expect(trusted.headers.Authorization).toBe('Bearer secret-token');
        const elsewhere = await fetchFor('https://gateway.example/other/x.png', { trustedOrigins: ['https://gateway.example'] });
        expect(elsewhere.headers.Authorization).toBeUndefined();
    });
});
