/** @jest-environment jsdom */
import { describe, it, expect } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useConversationCall } from '../../../src/client/video/useConversationCall';
import { makeFakeGateway, makeFakeMedia, makeFakePlatformApi } from './fakes';
const lobbyName = 'orgiq:initiative:owned-project';
function setup(reply?: (body: Record<string, string>, signal?: AbortSignal) => Promise<unknown>) {
  const g = makeFakeGateway(); const gateway = Object.assign(g.gw, { clientId: 'socket-owned' });
  const m = makeFakeMedia(), pa = makeFakePlatformApi(); const bindings: Record<string, string>[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/call-binding')) {
      const body = JSON.parse(String(init.body)); bindings.push(body);
      return reply ? reply(body, init.signal ?? undefined) : { ok: true, status: 200, json: async () => ({ ...body, bound: true, sessionId: 'sess-1', channelArn: 'arn:owned' }) };
    }
    return pa.fetchImpl(url, init);
  }) as typeof fetch;
  const hook = renderHook(() => useConversationCall({ lobbyName, self: { userId: 'reader', displayName: 'Reader' },
    gateway, platformApi: pa.platformApi, fetch: fetchImpl, useMedia: m.useFakeMedia, deviceStorage: null, bindRecordingCall: true }));
  const start = async () => { await act(async () => { await hook.result.current.start([]); }); };
  const joined = () => act(() => m.set({ isJoined: true, connectionState: 'connected' }));
  return { g, gateway, m, pa, hook, bindings, start, joined };
}
describe('verified recording call association', () => {
  it('passes actual socket identity at join and waits for media plus a durable matching native ACK', async () => {
    const s = setup(); await s.start();
    expect(s.pa.calls.find(row => row.path.endsWith('/join'))?.body.clientId).toBe('socket-owned');
    expect(s.bindings).toHaveLength(0); s.joined();
    await waitFor(() => expect(s.hook.result.current.recordingBinding?.status).toBe('bound'));
    expect(s.bindings).toEqual([{ lobbyName, callId: s.hook.result.current.call!.callId, participantId: 'p-self-1', clientId: 'socket-owned' }]);
  });
  it('binds the canonical adopted huddle rather than a locally minted id', async () => {
    const s = setup(); await s.start();
    act(() => s.g.push('active-call', { lobbyName, callId: 'canonical-call', active: true, participantUserIds: ['reader'] }));
    s.joined(); await waitFor(() => expect(s.hook.result.current.recordingBinding).toEqual({ status: 'bound', callId: 'canonical-call' }));
    expect(s.bindings[0]!.callId).toBe('canonical-call');
  });
  it('retries a registration race without treating a denied call as bound', async () => {
    let requests = 0;
    const s = setup(async body => ++requests === 1 ? { ok: false, status: 403, json: async () => ({ error: 'Not seated' }) }
      : { ok: true, status: 200, json: async () => ({ ...body, bound: true, sessionId: 'sess-1', channelArn: 'arn:owned' }) });
    await s.start(); s.joined(); await waitFor(() => expect(requests).toBe(1));
    expect(s.hook.result.current.recordingBinding?.status).toBe('pending');
    await waitFor(() => expect(s.hook.result.current.recordingBinding?.status).toBe('bound'));
    expect(requests).toBe(2);
  });
  it('rejects mismatched confirmation without ending the media call', async () => {
    const s = setup(async body => ({ ok: true, status: 200, json: async () => ({ ...body, callId: 'another-call', bound: true, sessionId: 'sess-1', channelArn: 'arn:owned' }) }));
    await s.start(); s.joined(); await waitFor(() => expect(s.hook.result.current.recordingBinding?.status).toBe('unavailable'));
    expect(s.hook.result.current.phase).toBe('live'); expect(s.hook.result.current.error).toBeNull();
  });
  it('aborts a previous tuple and ignores its late confirmation after canonical call adoption', async () => {
    const pending: Array<{ body: Record<string, string>; signal?: AbortSignal; resolve(value: unknown): void }> = [];
    const s = setup((body, signal) => new Promise(resolve => pending.push({ body, signal, resolve })));
    await s.start(); s.joined(); await waitFor(() => expect(pending).toHaveLength(1));
    act(() => s.g.push('active-call', { lobbyName, callId: 'canonical-later', active: true, participantUserIds: ['reader'] }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]!.signal?.aborted).toBe(true);
    const confirm = (item: typeof pending[number]) => item.resolve({ ok: true, status: 200, json: async () => ({ ...item.body, bound: true, sessionId: 'sess-1', channelArn: 'arn:owned' }) });
    await act(async () => { confirm(pending[0]!); });
    expect(s.hook.result.current.recordingBinding).toEqual({ status: 'pending', callId: 'canonical-later' });
    await act(async () => { confirm(pending[1]!); });
    expect(s.hook.result.current.recordingBinding).toEqual({ status: 'bound', callId: 'canonical-later' });
  });
  it('does not rewrite an existing media participant for a different gateway socket', async () => {
    const s = setup(); await s.start(); s.joined();
    await waitFor(() => expect(s.hook.result.current.recordingBinding?.status).toBe('bound'));
    s.gateway.clientId = 'different-socket'; s.hook.rerender();
    await waitFor(() => expect(s.hook.result.current.recordingBinding?.status).toBe('unavailable'));
    expect(s.bindings).toHaveLength(1);
  });
});
