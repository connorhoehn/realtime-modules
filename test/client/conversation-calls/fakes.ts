import { useSyncExternalStore } from 'react';
import type { UseLVSHangoutOptions, UseLVSHangoutResult, HangoutParticipant } from '../../../src/client/video/useLVSHangout';

export { makeFakeGateway } from '../document-calls/fakeGateway';

/** Fake platform-api for the conversation hook (getIdToken, not headers). */
export function makeFakePlatformApi(opts: { joinStatus?: number } = {}) {
  const calls: Array<{ method: string; path: string; body: any; headers: Record<string, string> }> = [];
  let n = 0;
  const fetchImpl = (async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const path = url.replace('http://pa', '');
    const method = init.method ?? 'GET';
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    const json = (status: number, b: unknown) => ({ ok: status < 400, status, json: async () => b });
    if (method === 'POST' && path === '/api/video/sessions') return json(201, { sessionId: `sess-${++n}` });
    if (method === 'POST' && /\/join$/.test(path)) {
      if (opts.joinStatus && opts.joinStatus >= 400) return json(opts.joinStatus, { error: 'gone' });
      return json(200, { token: 'stage-token', participantId: `p-self-${n}`, userId: 'u' });
    }
    if (method === 'POST' && /\/end$/.test(path)) return json(200, { ended: false });
    return json(404, { error: 'no route' });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, platformApi: { baseUrl: 'http://pa', getIdToken: async () => 'id-token' } };
}

/** A media layer the test drives: joined flag, remote members, calls made. */
export function makeFakeMedia() {
  let state = { isJoined: false, remotes: [] as HangoutParticipant[], connectionState: 'idle' as UseLVSHangoutResult['connectionState'], error: null as string | null };
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const lastOpts: { current: UseLVSHangoutOptions | null } = { current: null };
  const set = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; for (const l of Array.from(listeners)) l(); };
  const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
  function useFakeMedia(opts: UseLVSHangoutOptions): UseLVSHangoutResult {
    lastOpts.current = opts;
    const s = useSyncExternalStore(subscribe, () => state);
    const on = !!opts.stageToken;
    const local: HangoutParticipant = { participantId: opts.participantId ?? 'local', displayName: opts.userId, userId: opts.userId, isLocal: true, streams: [], hasAudio: true, hasVideo: true };
    return {
      participants: on ? [local, ...s.remotes] : [],
      isJoined: on && s.isJoined,
      isScreenSharing: false,
      isCameraEnabled: true,
      error: on ? s.error : null,
      videoUnavailable: null,
      connectionState: on ? s.connectionState : 'idle',
      toggleMute: (m) => { calls.push(`mute:${m}`); },
      toggleCamera: (off) => { calls.push(`cameraOff:${off}`); },
      enableCamera: async () => { calls.push('enableCamera'); },
      disableCamera: async () => { calls.push('disableCamera'); },
      setCameraEnabled: async (v) => { calls.push(`camera:${v}`); },
      startScreenShare: async () => { calls.push('share'); },
      stopScreenShare: () => { calls.push('unshare'); },
      leave: () => { calls.push('leave'); },
    };
  }
  const remote = (pid: string): HangoutParticipant => ({ participantId: pid, displayName: pid, userId: pid, isLocal: false, streams: [], hasAudio: true, hasVideo: true });
  return { useFakeMedia, set, calls, lastOpts, remote };
}
