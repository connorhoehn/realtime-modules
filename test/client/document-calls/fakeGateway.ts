import type { GatewayMessage } from '../../../src/client/types';

/** A fake gateway: records what the hook sends, lets the test push frames. */
export function makeFakeGateway() {
  const handlers = new Set<(msg: GatewayMessage) => void>();
  const sent: Record<string, any>[] = [];
  const gw = {
    connectionState: 'connected' as string,
    sessionEpoch: 1,
    send: (msg: Record<string, unknown>) => { sent.push(msg as Record<string, any>); },
    onMessage: (h: (msg: GatewayMessage) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
  };
  return {
    gw,
    sent,
    push(action: string, data: Record<string, unknown>) {
      for (const h of Array.from(handlers)) h({ type: 'call', action, data, timestamp: new Date().toISOString() } as unknown as GatewayMessage);
    },
    callFrames(action?: string) {
      return sent.filter((m) => m.service === 'call' && (!action || m.action === action));
    },
  };
}

/** Fake platform-api: records requests, answers the video-session routes. */
export function makeFakePlatformApi(opts: { sessions?: Record<string, unknown>[]; endResult?: { ended: boolean } } = {}) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let n = 0;
  const fetchImpl = (async (url: string, init: { method?: string; body?: string } = {}) => {
    const path = url.replace('http://pa', '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b });
    if (method === 'POST' && path === '/api/video/sessions') return json(201, { sessionId: `sess-${++n}`, recording: { enabled: true, reason: 'default-on' } });
    if (method === 'POST' && /\/join$/.test(path)) return json(200, { token: 'stage-token', participantId: 'p-1', userId: 'u-host' });
    if (method === 'POST' && /\/end$/.test(path)) return json(200, opts.endResult ?? { remaining: 1, ended: false });
    if (method === 'GET' && path.startsWith('/api/video/sessions/document/')) return json(200, { sessions: opts.sessions ?? [] });
    if (method === 'GET') return json(404, { error: 'not found' });
    if (method === 'PATCH') return json(200, {});
    return json(404, { error: 'no route' });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, platformApi: { baseUrl: 'http://pa', getAuthHeaders: async () => ({ Authorization: 'Bearer t' }) } };
}
