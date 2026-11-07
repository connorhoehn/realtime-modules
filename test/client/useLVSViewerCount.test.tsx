/**
 * @jest-environment jsdom
 */
// The audience figure a broadcast is about.
//
// The distinction this file exists to protect: null is NOT zero. Null means
// "we have not been told"; zero means "nobody is watching". Collapsing them
// invents a fact, and on a working stream it shows the presenter the most
// discouraging thing available.

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { LVSProvider } from '../../src/client/video/LVSProvider';
import { useLVSViewerCount } from '../../src/client/video/useLVSViewerCount';

const BASE = 'http://lvs.local';
const ARN = 'arn:channel:demo';

function mockFetch(impl: (url: string) => Promise<Partial<Response>> | Partial<Response>) {
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: unknown) =>
    impl(String(url)) as unknown as Response);
}

afterEach(() => { jest.useRealTimers(); });

describe('useLVSViewerCount', () => {
  it('reports the count LVS gives', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ concurrent_viewers: 42 }) }));
    const { result } = renderHook(() => useLVSViewerCount({ channelArn: ARN, baseUrl: BASE, playbackToken: 'tok' }));
    await waitFor(() => expect(result.current.viewerCount).toBe(42));
  });

  it('asks the channel-scoped endpoint', async () => {
    const seen: string[] = [];
    mockFetch((url) => { seen.push(url); return { ok: true, json: async () => ({ concurrent_viewers: 0 }) }; });
    renderHook(() => useLVSViewerCount({ channelArn: ARN, baseUrl: BASE, playbackToken: 'tok' }));
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]).toBe(`${BASE}/api/channels/${encodeURIComponent(ARN)}/viewers`);
  });

  it('keeps zero distinct from unknown', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ concurrent_viewers: 0 }) }));
    const { result } = renderHook(() => useLVSViewerCount({ channelArn: ARN, baseUrl: BASE, playbackToken: 'tok' }));
    await waitFor(() => expect(result.current.viewerCount).toBe(0));
    expect(result.current.viewerCount).not.toBeNull();
  });

  // 503 is LVS saying it has no viewer tracker — unknown, not an empty house.
  it('reports unknown when the tracker is unavailable', async () => {
    mockFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
    const { result } = renderHook(() => useLVSViewerCount({ channelArn: ARN, baseUrl: BASE, playbackToken: 'tok' }));
    await waitFor(() => expect((globalThis.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(0));
    expect(result.current.viewerCount).toBeNull();
  });

  it('does not take the page down when the request fails', async () => {
    mockFetch(() => { throw new Error('network down'); });
    const { result } = renderHook(() => useLVSViewerCount({ channelArn: ARN, baseUrl: BASE, playbackToken: 'tok' }));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.viewerCount).toBeNull();
  });

  it('is idle with no channel — the pre-broadcast state', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ concurrent_viewers: 9 }) }));
    const { result } = renderHook(() => useLVSViewerCount({ channelArn: null, baseUrl: BASE }));
    expect(result.current.viewerCount).toBeNull();
    expect(globalThis.fetch as jest.Mock).not.toHaveBeenCalled();
  });

  // A channel that changed must not keep showing the previous one's audience.
  it('drops the old count when the channel changes', async () => {
    mockFetch((url) => ({
      ok: true,
      json: async () => ({ concurrent_viewers: url.includes('one') ? 7 : 3 }),
    }));
    const { result, rerender } = renderHook(
      ({ arn }) => useLVSViewerCount({ channelArn: arn, baseUrl: BASE, playbackToken: 'tok' }),
      { initialProps: { arn: 'one' } },
    );
    await waitFor(() => expect(result.current.viewerCount).toBe(7));
    rerender({ arn: 'two' });
    await waitFor(() => expect(result.current.viewerCount).toBe(3));
  });

  it('sends the token as a bearer header, never in the URL', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
      calls.push([String(url), init]);
      return { ok: true, json: async () => ({ concurrent_viewers: 1 }) } as unknown as Response;
    });
    renderHook(() => useLVSViewerCount({ channelArn: ARN, baseUrl: BASE, playbackToken: 'secret-tok' }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect((calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer secret-tok');
    expect(calls[0][0]).not.toContain('secret-tok');
    expect(calls[0][0]).not.toContain('?');
  });

  it('takes the token from the LVSProvider when the option is absent', async () => {
    const calls: Array<RequestInit | undefined> = [];
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (_u: unknown, init?: RequestInit) => {
      calls.push(init);
      return { ok: true, json: async () => ({ concurrent_viewers: 2 }) } as unknown as Response;
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(LVSProvider, { baseUrl: BASE, getAuthToken: async () => 'ctx-tok', children });
    renderHook(() => useLVSViewerCount({ channelArn: ARN }), { wrapper });
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect((calls[0]?.headers as Record<string, string>).Authorization).toBe('Bearer ctx-tok');
  });

  it('makes no request without a token, and warns once', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch(() => ({ ok: true, json: async () => ({ concurrent_viewers: 9 }) }));
    const { result } = renderHook(() =>
      useLVSViewerCount({ channelArn: ARN, baseUrl: BASE, intervalMs: 2000 }));
    await act(async () => { await jest.advanceTimersByTimeAsync(7000); });
    expect(globalThis.fetch as jest.Mock).not.toHaveBeenCalled();
    expect(result.current.viewerCount).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
