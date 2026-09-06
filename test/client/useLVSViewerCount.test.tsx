/**
 * @jest-environment jsdom
 */
// The audience figure a broadcast is about.
//
// The distinction this file exists to protect: null is NOT zero. Null means
// "we have not been told"; zero means "nobody is watching". Collapsing them
// invents a fact, and on a working stream it shows the presenter the most
// discouraging thing available.

import { renderHook, waitFor } from '@testing-library/react';
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
    const { result } = renderHook(() => useLVSViewerCount({ channelArn: ARN, baseUrl: BASE }));
    await waitFor(() => expect(result.current.viewerCount).toBe(42));
  });

  it('asks the channel-scoped endpoint', async () => {
    const seen: string[] = [];
    mockFetch((url) => { seen.push(url); return { ok: true, json: async () => ({ concurrent_viewers: 0 }) }; });
    renderHook(() => useLVSViewerCount({ channelArn: ARN, baseUrl: BASE }));
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]).toBe(`${BASE}/api/channels/${encodeURIComponent(ARN)}/viewers`);
  });

  it('keeps zero distinct from unknown', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ concurrent_viewers: 0 }) }));
    const { result } = renderHook(() => useLVSViewerCount({ channelArn: ARN, baseUrl: BASE }));
    await waitFor(() => expect(result.current.viewerCount).toBe(0));
    expect(result.current.viewerCount).not.toBeNull();
  });

  // 503 is LVS saying it has no viewer tracker — unknown, not an empty house.
  it('reports unknown when the tracker is unavailable', async () => {
    mockFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
    const { result } = renderHook(() => useLVSViewerCount({ channelArn: ARN, baseUrl: BASE }));
    await waitFor(() => expect((globalThis.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(0));
    expect(result.current.viewerCount).toBeNull();
  });

  it('does not take the page down when the request fails', async () => {
    mockFetch(() => { throw new Error('network down'); });
    const { result } = renderHook(() => useLVSViewerCount({ channelArn: ARN, baseUrl: BASE }));
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
      ({ arn }) => useLVSViewerCount({ channelArn: arn, baseUrl: BASE }),
      { initialProps: { arn: 'one' } },
    );
    await waitFor(() => expect(result.current.viewerCount).toBe(7));
    rerender({ arn: 'two' });
    await waitFor(() => expect(result.current.viewerCount).toBe(3));
  });
});
