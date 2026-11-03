// Coverage for the raw WHIP/WHEP transport — focused on the 425
// ("Too Early") retry path that lets us consume the LVS SFU's
// mesh-fanout-filter rollout safely. When MESH_FANOUT_FILTER_ENABLED
// flips on the SFU, a WHEP hitting a cache-miss pod returns 425 with
// a Retry-After hint while the pipe to the publisher pod warms up;
// without retry, viewers black-screen during warmup.
//
// Reference pattern lives at
// `~/Projects/live-video-streaming/packages/lvs-client/src/whep.js:127-162`.

import {
  describe, it, expect, jest, beforeEach,
} from '@jest/globals';

import {
  whepPublish,
  whipPublish,
  parseRetryAfter,
  computeTooEarlyBackoffMs,
  LVSApiError,
  fetchIceServers,
  fetchIceConfig,
} from '../../src/client/video/lib/transport';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeResponse(
  body: string,
  init?: { status?: number; statusText?: string; headers?: Record<string, string> },
): Response {
  return new Response(body, init);
}

interface Scripted {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** Build a scripted fetch mock that returns each entry in order. The
 *  last entry repeats forever — convenient for "fail N times then
 *  succeed" patterns. */
function scriptedFetch(steps: Scripted[]): jest.Mock {
  let i = 0;
  return jest.fn(async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return makeResponse(step.body ?? '', {
      status: step.status,
      headers: step.headers,
    });
  });
}

/** Synchronous "sleep" that just resolves — the 425 loop's actual
 *  delay value is asserted via the captured log lines, not by wall
 *  time. Keeps the suite fast and deterministic. */
const fastSleep = async (_ms: number) => {};

// ---------------------------------------------------------------------------
// parseRetryAfter
// ---------------------------------------------------------------------------

describe('parseRetryAfter', () => {
  it('parses integer delta-seconds', () => {
    expect(parseRetryAfter('5')).toBe(5);
    expect(parseRetryAfter('  0  ')).toBe(0);
  });

  it('parses fractional delta-seconds (SFU hints sub-second)', () => {
    expect(parseRetryAfter('0.5')).toBeCloseTo(0.5);
    expect(parseRetryAfter('1.25')).toBeCloseTo(1.25);
  });

  it('returns null for absent / empty / malformed input', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('   ')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });

  it('parses HTTP-date form into a positive delta', () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const parsed = parseRetryAfter(future);
    expect(parsed).not.toBeNull();
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(31);
  });

  it('returns null for past HTTP-date', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeTooEarlyBackoffMs
// ---------------------------------------------------------------------------

describe('computeTooEarlyBackoffMs', () => {
  it('honours Retry-After when it falls in the [250, 2000] range', () => {
    expect(computeTooEarlyBackoffMs(0.5)).toBe(500);
    expect(computeTooEarlyBackoffMs(1)).toBe(1000);
    expect(computeTooEarlyBackoffMs(1.75)).toBe(1750);
  });

  it('clamps Retry-After below the 250ms floor', () => {
    expect(computeTooEarlyBackoffMs(0.05)).toBe(250);
  });

  it('clamps Retry-After above the 2000ms ceiling', () => {
    expect(computeTooEarlyBackoffMs(10)).toBe(2000);
  });

  it('jitters within [250, 2000] when Retry-After is absent', () => {
    expect(computeTooEarlyBackoffMs(null, () => 0)).toBe(250);
    expect(computeTooEarlyBackoffMs(null, () => 0.9999)).toBe(2000 - 1);
    const mid = computeTooEarlyBackoffMs(null, () => 0.5);
    expect(mid).toBeGreaterThanOrEqual(250);
    expect(mid).toBeLessThanOrEqual(2000);
  });
});

// ---------------------------------------------------------------------------
// whepPublish — 425 retry path (SFU mesh-fanout-filter rollout)
// ---------------------------------------------------------------------------

describe('whepPublish 425 Too Early retry', () => {
  const baseArgs = {
    channelArn: 'arn:local:ivs:channel/test',
    offerSdp: 'v=0\r\n',
    authToken: 'tok',
    baseUrl: 'http://sfu',
  } as const;

  let logLines: string[] = [];
  beforeEach(() => { logLines = []; });
  const captureLog = (msg: string) => { logLines.push(msg); };

  it('succeeds after one 425 then a 201', async () => {
    const fetchImpl = scriptedFetch([
      { status: 425, headers: { 'Retry-After': '0.3' } },
      { status: 201, body: 'v=0\r\nanswer\r\n', headers: { Location: '/whep/r-1' } },
    ]);
    const res = await whepPublish({
      ...baseArgs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: captureLog,
      __tooEarlyDeps: { sleep: fastSleep },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res.answerSdp).toBe('v=0\r\nanswer\r\n');
    expect(res.location).toBe('http://sfu/whep/r-1');
    expect(logLines.some((l) => /425 Too Early/.test(l) && /attempt=1\/5/.test(l))).toBe(true);
  });

  it('succeeds after multiple 425s, well under the budget', async () => {
    const fetchImpl = scriptedFetch([
      { status: 425, headers: { 'Retry-After': '0.3' } },
      { status: 425, headers: { 'Retry-After': '0.3' } },
      { status: 425 }, // no Retry-After → jittered backoff
      { status: 200, body: 'v=0\r\nanswer\r\n', headers: { Location: '/whep/r-7' } },
    ]);
    const res = await whepPublish({
      ...baseArgs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: captureLog,
      __tooEarlyDeps: { sleep: fastSleep, rand: () => 0.5 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(res.answerSdp).toBe('v=0\r\nanswer\r\n');
    const retryLines = logLines.filter((l) => /425 Too Early/.test(l));
    expect(retryLines.length).toBe(3);
  });

  it('caps at 5 attempts total and throws LVSApiError on the final 425', async () => {
    const fetchImpl = scriptedFetch([
      { status: 425, headers: { 'Retry-After': '0.3' } },
    ]);
    await expect(whepPublish({
      ...baseArgs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: captureLog,
      __tooEarlyDeps: { sleep: fastSleep },
    })).rejects.toBeInstanceOf(LVSApiError);

    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(logLines.some((l) => /retry budget exhausted/.test(l) && /attemptCap=true/.test(l))).toBe(true);
  });

  it('bails when the 5-second deadline expires even if attempts remain', async () => {
    // Synthetic clock: each tick advances by 2s so the second 425
    // pushes elapsed past the 5s deadline before attempt 3 is taken.
    let now = 1_000_000;
    const tickingNow = () => { now += 2_000; return now; };
    const fetchImpl = scriptedFetch([
      { status: 425, headers: { 'Retry-After': '0.3' } },
    ]);

    await expect(whepPublish({
      ...baseArgs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: captureLog,
      __tooEarlyDeps: { sleep: fastSleep, now: tickingNow },
    })).rejects.toBeInstanceOf(LVSApiError);

    // attempt 1: elapsed=2000 (continue), attempt 2: elapsed=4000 (continue),
    // attempt 3: elapsed=6000 (>= 5000 deadline → bail).
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(logLines.some((l) => /retry budget exhausted/.test(l) && /deadlineHit=true/.test(l))).toBe(true);
  });

  it('does NOT retry on 4xx other than 425', async () => {
    const fetchImpl = scriptedFetch([
      { status: 401, body: 'unauthorized' },
    ]);
    await expect(whepPublish({
      ...baseArgs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: captureLog,
      __tooEarlyDeps: { sleep: fastSleep },
    })).rejects.toMatchObject({ name: 'LVSApiError', status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logLines).toHaveLength(0);
  });

  it('does NOT retry on 5xx', async () => {
    const fetchImpl = scriptedFetch([
      { status: 503, body: 'unavail', headers: { 'Retry-After': '30' } },
    ]);
    await expect(whepPublish({
      ...baseArgs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: captureLog,
      __tooEarlyDeps: { sleep: fastSleep },
    })).rejects.toMatchObject({ name: 'LVSApiError', status: 503, retryAfterSec: 30 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('propagates network errors without retrying', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('ECONNRESET'); });
    await expect(whepPublish({
      ...baseArgs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: captureLog,
      __tooEarlyDeps: { sleep: fastSleep },
    })).rejects.toThrow('ECONNRESET');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('emits one debug-log line per 425 attempt for devtools observability', async () => {
    const fetchImpl = scriptedFetch([
      { status: 425 },
      { status: 425 },
      { status: 200, body: 'ok', headers: { Location: '/r' } },
    ]);
    await whepPublish({
      ...baseArgs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: captureLog,
      __tooEarlyDeps: { sleep: fastSleep, rand: () => 0.25 },
    });
    const retryLines = logLines.filter((l) => /425 Too Early/.test(l));
    expect(retryLines).toHaveLength(2);
    expect(retryLines[0]).toMatch(/\[lvs:whep\]/);
    expect(retryLines[0]).toMatch(/attempt=1\/5/);
    expect(retryLines[1]).toMatch(/attempt=2\/5/);
  });
});

// ---------------------------------------------------------------------------
// whipPublish — same shape, consistency-only (425 is rare for WHIP)
// ---------------------------------------------------------------------------

describe('whipPublish 425 Too Early retry (consistency with WHEP)', () => {
  const baseArgs = {
    channelArn: 'arn:local:ivs:channel/test',
    offerSdp: 'v=0\r\n',
    authToken: 'tok',
    baseUrl: 'http://sfu',
  } as const;

  it('retries on 425 and eventually succeeds', async () => {
    const logLines: string[] = [];
    const fetchImpl = scriptedFetch([
      { status: 425, headers: { 'Retry-After': '0.3' } },
      { status: 201, body: 'ans', headers: { Location: '/whip/r-1' } },
    ]);
    const res = await whipPublish({
      ...baseArgs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: (m: string) => logLines.push(m),
      __tooEarlyDeps: { sleep: fastSleep },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res.location).toBe('http://sfu/whip/r-1');
    expect(logLines.some((l) => /\[lvs:whip\]/.test(l) && /425 Too Early/.test(l))).toBe(true);
  });

  it('still throws on non-425 errors with existing LVSApiError shape', async () => {
    const fetchImpl = scriptedFetch([
      { status: 409, body: 'channel exists' },
    ]);
    await expect(whipPublish({
      ...baseArgs,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      __tooEarlyDeps: { sleep: fastSleep },
    })).rejects.toMatchObject({ name: 'LVSApiError', status: 409 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Location resolution — the SFU answers with a RELATIVE Location. Handed to
// fetch as-is, the teardown DELETE resolved against the page's origin (404
// on every Leave) instead of the SFU.
// ---------------------------------------------------------------------------

describe('WHIP/WHEP Location is resolved against the SFU endpoint', () => {
  const args = {
    channelArn: 'arn:local:ivs:channel/test',
    offerSdp: 'v=0\r\n',
    authToken: 'tok',
    baseUrl: 'http://localhost:3901',
  } as const;

  it.each([
    ['whip', whipPublish],
    ['whep', whepPublish],
  ] as const)('%s: a relative Location becomes an absolute SFU URL', async (kind, fn) => {
    const fetchImpl = scriptedFetch([
      { status: 201, body: 'ans', headers: { Location: `/api/channels/c/${kind}/res-1` } },
    ]);
    const res = await fn({ ...args, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res.location).toBe(`http://localhost:3901/api/channels/c/${kind}/res-1`);
  });

  it.each([
    ['whip', whipPublish],
    ['whep', whepPublish],
  ] as const)('%s: an absolute Location is kept as-is', async (kind, fn) => {
    const abs = `https://sfu-2.example.com/api/channels/c/${kind}/res-2`;
    const fetchImpl = scriptedFetch([{ status: 201, body: 'ans', headers: { Location: abs } }]);
    const res = await fn({ ...args, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res.location).toBe(abs);
  });

  it('same-origin (no baseUrl) keeps a relative Location relative, which is already correct', async () => {
    const fetchImpl = scriptedFetch([{ status: 201, body: 'ans', headers: { Location: '/api/channels/c/whip/r' } }]);
    const res = await whipPublish({ ...args, baseUrl: undefined, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res.location).toBe('/api/channels/c/whip/r');
  });

  it('a missing Location stays null', async () => {
    const fetchImpl = scriptedFetch([{ status: 201, body: 'ans' }]);
    const res = await whepPublish({ ...args, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res.location).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ICE servers — the SFU's answer is authoritative, including an empty list.
// Replacing `[]` with public STUN made every WHIP/WHEP wait out the 3 s
// gather cap in browsers whose STUN gathering never completes (headed Chrome
// with VPN/virtual interfaces: still `gathering` at 10 s vs ~120 ms without
// servers) — the ~3 s second-arrival in room calls.
// ---------------------------------------------------------------------------

describe('fetchIceServers', () => {
  const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
  const respond = (status: number, body: string) => jest.fn(async (_url: string) => new Response(body, { status }));

  it('honours an explicit empty list from the SFU (host candidates only)', async () => {
    const f = respond(200, JSON.stringify({ iceServers: [], iceTransportPolicy: 'all' }));
    await expect(fetchIceServers('http://sfu', f as unknown as typeof fetch)).resolves.toEqual([]);
    expect(f).toHaveBeenCalledWith('http://sfu/api/ice-servers');
  });

  it('returns the SFU list when it has servers', async () => {
    const turn = [{ urls: 'turn:t.example:3478', username: 'u', credential: 'c' }];
    const f = respond(200, JSON.stringify({ iceServers: turn }));
    await expect(fetchIceServers('http://sfu', f as unknown as typeof fetch)).resolves.toEqual(turn);
  });

  it.each([
    ['a non-2xx answer', respond(503, 'down')],
    ['a body without iceServers', respond(200, '{}')],
    ['a non-JSON body', respond(200, '<html>')],
    ['a network error', jest.fn(async (_url: string): Promise<Response> => { throw new TypeError('fetch failed'); })],
  ])('falls back to public STUN on %s', async (_label, f) => {
    await expect(fetchIceServers('http://sfu', f as unknown as typeof fetch)).resolves.toEqual(STUN);
  });
});

// ---------------------------------------------------------------------------
// ICE config with the stage token — the SFU includes TURN entries only for a
// request carrying a valid stage token, and may require relay-only gathering.
// ---------------------------------------------------------------------------

describe('fetchIceConfig', () => {
  const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
  const TURN = [{ urls: 'turn:t.example:3478', username: 'u', credential: 'c' }];
  const respond = (status: number, body: string) =>
    jest.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status }));
  const authHeader = (f: ReturnType<typeof respond>) => {
    const init = f.mock.calls[0]?.[1] as RequestInit | undefined;
    return new Headers(init?.headers).get('Authorization');
  };

  it('sends the stage token as a Bearer header when one is given', async () => {
    const f = respond(200, JSON.stringify({ iceServers: TURN, iceTransportPolicy: 'all' }));
    await expect(fetchIceConfig({ baseUrl: 'http://sfu', authToken: 'stage.jwt', fetchImpl: f as unknown as typeof fetch }))
      .resolves.toEqual({ iceServers: TURN, iceTransportPolicy: 'all' });
    expect(f.mock.calls[0]?.[0]).toBe('http://sfu/api/ice-servers');
    expect(authHeader(f)).toBe('Bearer stage.jwt');
  });

  it.each([['no token', undefined], ['an empty token', ''], ['a null token', null]])(
    'sends no Authorization header with %s',
    async (_label, authToken) => {
      const f = respond(200, JSON.stringify({ iceServers: [] }));
      await fetchIceConfig({ baseUrl: 'http://sfu', authToken, fetchImpl: f as unknown as typeof fetch });
      expect(f).toHaveBeenCalledWith('http://sfu/api/ice-servers');
      expect(authHeader(f)).toBeNull();
    },
  );

  it('honours the relay policy', async () => {
    const f = respond(200, JSON.stringify({ iceServers: TURN, iceTransportPolicy: 'relay' }));
    await expect(fetchIceConfig({ baseUrl: 'http://sfu', authToken: 't', fetchImpl: f as unknown as typeof fetch }))
      .resolves.toEqual({ iceServers: TURN, iceTransportPolicy: 'relay' });
  });

  it.each([['absent', undefined], ['unknown', 'public'], ['not a string', 1]])(
    'defaults the policy to all when it is %s',
    async (_label, policy) => {
      const f = respond(200, JSON.stringify({ iceServers: TURN, iceTransportPolicy: policy }));
      await expect(fetchIceConfig({ baseUrl: 'http://sfu', fetchImpl: f as unknown as typeof fetch }))
        .resolves.toEqual({ iceServers: TURN, iceTransportPolicy: 'all' });
    },
  );

  it('honours an explicit empty list, with or without a token', async () => {
    for (const authToken of [undefined, 'stage.jwt']) {
      const f = respond(200, JSON.stringify({ iceServers: [], iceTransportPolicy: 'all' }));
      await expect(fetchIceConfig({ baseUrl: 'http://sfu', authToken, fetchImpl: f as unknown as typeof fetch }))
        .resolves.toEqual({ iceServers: [], iceTransportPolicy: 'all' });
    }
  });

  it.each([
    ['a non-2xx answer', respond(503, 'down')],
    ['a 401 answer', respond(401, 'unauthorized')],
    ['a body without iceServers', respond(200, '{"iceTransportPolicy":"relay"}')],
    ['a null body', respond(200, 'null')],
    ['a non-JSON body', respond(200, '<html>')],
    ['a network error', jest.fn(async (_url: string, _init?: RequestInit): Promise<Response> => { throw new TypeError('fetch failed'); })],
  ])('falls back to public STUN with policy all on %s', async (_label, f) => {
    await expect(fetchIceConfig({ baseUrl: 'http://sfu', authToken: 't', fetchImpl: f as unknown as typeof fetch }))
      .resolves.toEqual({ iceServers: STUN, iceTransportPolicy: 'all' });
  });

  it('defaults to same-origin', async () => {
    const f = respond(200, JSON.stringify({ iceServers: [] }));
    await fetchIceConfig({ fetchImpl: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledWith('/api/ice-servers');
  });

  it('fetchIceServers forwards an optional token as its third argument', async () => {
    const f = respond(200, JSON.stringify({ iceServers: TURN, iceTransportPolicy: 'relay' }));
    await expect(fetchIceServers('http://sfu', f as unknown as typeof fetch, 'stage.jwt')).resolves.toEqual(TURN);
    expect(authHeader(f)).toBe('Bearer stage.jwt');
  });
});
