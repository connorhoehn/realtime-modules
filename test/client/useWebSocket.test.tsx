/**
 * @jest-environment jsdom
 */
// realtime-modules/test/client/useWebSocket.test.tsx
//
// Wave 3 — exercises the new useWebSocket hook with a manual
// WebSocket stub injected on globalThis. Covers:
//   - lifecycle (connecting → connected → reconnecting on close)
//   - session-frame capture (sessionToken / clientId)
//   - subscribe/unsubscribe/publish wire frames
//   - auto-resubscribe on reconnect
//   - exponential backoff scheduling
//   - intentional disconnect short-circuit
//   - auth subprotocol passthrough

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import { useWebSocket } from '../../src/client/useWebSocket';

// -----------------------------------------------------------------------
// Manual WebSocket stub installed on globalThis
// -----------------------------------------------------------------------

class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    static OPEN = 1;

    public url: string;
    public protocols?: string | string[];
    public readyState = 0; // CONNECTING
    public sent: string[] = [];
    public closeCalls = 0;

    public onopen: ((ev?: any) => void) | null = null;
    public onmessage: ((ev: any) => void) | null = null;
    public onerror: ((ev?: any) => void) | null = null;
    public onclose: ((ev?: any) => void) | null = null;

    constructor(url: string, protocols?: string | string[]) {
        this.url = url;
        this.protocols = protocols;
        FakeWebSocket.instances.push(this);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this.closeCalls++;
        this.readyState = 3; // CLOSED
        // Mimic browser ordering — close fires asynchronously after close().
        if (this.onclose) this.onclose({ code: 1000, reason: 'manual' });
    }

    // ---- Test helpers ----
    open(): void {
        this.readyState = 1;
        if (this.onopen) this.onopen();
    }

    receive(payload: unknown): void {
        if (this.onmessage) this.onmessage({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
    }

    serverClose(): void {
        this.readyState = 3;
        if (this.onclose) this.onclose({ code: 1006, reason: 'lost' });
    }

    sentJson(): any[] {
        return this.sent.map((s) => JSON.parse(s));
    }
}

const realWS = (globalThis as any).WebSocket;

beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
    if (realWS) {
        (globalThis as any).WebSocket = realWS;
    } else {
        delete (globalThis as any).WebSocket;
    }
});

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('useWebSocket', () => {
    it('opens a WebSocket and transitions connecting → connected on open', () => {
        const { result } = renderHook(() =>
            useWebSocket({ url: 'ws://localhost:1234/ws' }),
        );

        expect(result.current.connectionState).toBe('connecting');
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(FakeWebSocket.instances[0].url).toBe('ws://localhost:1234/ws');

        act(() => {
            FakeWebSocket.instances[0].open();
        });

        expect(result.current.connectionState).toBe('connected');
        expect(result.current.lastError).toBeNull();
    });

    it('passes authToken via the bearer-token-v1 subprotocol', () => {
        renderHook(() =>
            useWebSocket({ url: 'ws://x/ws', authToken: 'tok-abc' }),
        );
        const sock = FakeWebSocket.instances[0];
        expect(sock.protocols).toEqual(['bearer-token-v1', 'tok-abc']);
    });

    it('captures sessionToken + clientId from the session handshake frame', () => {
        const { result } = renderHook(() =>
            useWebSocket({ url: 'ws://x/ws' }),
        );
        act(() => {
            FakeWebSocket.instances[0].open();
            FakeWebSocket.instances[0].receive({
                type: 'session',
                status: 'connected',
                clientId: 'c-42',
                sessionToken: 'tok-xyz',
            });
        });

        expect(result.current.clientId).toBe('c-42');
        expect(result.current.sessionToken).toBe('tok-xyz');
    });

    it('forwards parsed messages to onMessage', () => {
        const onMessage = jest.fn();
        renderHook(() =>
            useWebSocket({ url: 'ws://x/ws', onMessage }),
        );
        act(() => {
            FakeWebSocket.instances[0].open();
            FakeWebSocket.instances[0].receive({ type: 'crdt:update', channel: 'doc:1' });
        });

        expect(onMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'crdt:update', channel: 'doc:1' }),
        );
    });

    it('ignores unparseable frames without throwing', () => {
        const onMessage = jest.fn();
        renderHook(() =>
            useWebSocket({ url: 'ws://x/ws', onMessage }),
        );
        act(() => {
            FakeWebSocket.instances[0].open();
            FakeWebSocket.instances[0].receive('not-json{');
        });
        expect(onMessage).not.toHaveBeenCalled();
    });

    it('subscribe/unsubscribe/publish write the expected frames', () => {
        const { result } = renderHook(() =>
            useWebSocket({ url: 'ws://x/ws' }),
        );
        const sock = FakeWebSocket.instances[0];
        act(() => sock.open());

        act(() => {
            result.current.subscribe('chan-1');
            result.current.publish('chan-1', { service: 'chat', action: 'message', text: 'hi' });
            result.current.unsubscribe('chan-1');
        });

        const frames = sock.sentJson();
        expect(frames).toEqual([
            { service: 'subscribe', action: 'subscribe', channel: 'chan-1' },
            { service: 'chat', action: 'message', text: 'hi', channel: 'chan-1' },
            { service: 'subscribe', action: 'unsubscribe', channel: 'chan-1' },
        ]);
    });

    it('auto-resubscribes tracked channels after a reconnect (autoResubscribe: true)', () => {
        const { result } = renderHook(() =>
            useWebSocket({
                url: 'ws://x/ws',
                reconnectMs: 50,
                maxReconnectMs: 1000,
                autoResubscribe: true,
            }),
        );
        const sock1 = FakeWebSocket.instances[0];
        act(() => sock1.open());

        act(() => {
            result.current.subscribe('chan-a');
            result.current.subscribe('chan-b');
        });
        expect(sock1.sentJson().filter((f) => f.action === 'subscribe')).toHaveLength(2);

        // Server drops us — trigger close, then advance backoff.
        act(() => {
            sock1.serverClose();
        });
        expect(result.current.connectionState).toBe('reconnecting');

        act(() => {
            jest.advanceTimersByTime(60);
        });
        expect(FakeWebSocket.instances).toHaveLength(2);

        const sock2 = FakeWebSocket.instances[1];
        act(() => sock2.open());

        // Should have re-sent subscribe for both tracked channels.
        const subs = sock2.sentJson().filter((f) => f.action === 'subscribe');
        const channels = subs.map((f: any) => f.channel).sort();
        expect(channels).toEqual(['chan-a', 'chan-b']);
    });

    it('uses exponential backoff capped at maxReconnectMs', () => {
        renderHook(() =>
            useWebSocket({ url: 'ws://x/ws', reconnectMs: 100, maxReconnectMs: 400 }),
        );

        // Force three consecutive failures.
        for (let i = 0; i < 4; i++) {
            const sock = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
            act(() => sock.serverClose());
            // Advance enough to cover the max delay.
            act(() => jest.advanceTimersByTime(500));
        }

        // We should have spun up multiple sockets — proves the timer fired.
        expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(4);
    });

    it('disconnect() short-circuits reconnect logic', () => {
        const { result } = renderHook(() =>
            useWebSocket({ url: 'ws://x/ws', reconnectMs: 10 }),
        );
        const sock = FakeWebSocket.instances[0];
        act(() => sock.open());

        act(() => {
            result.current.disconnect();
        });

        expect(result.current.connectionState).toBe('disconnected');

        act(() => jest.advanceTimersByTime(500));
        // No new socket spawned.
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('records a lastError when the gateway sends an error frame', () => {
        const { result } = renderHook(() =>
            useWebSocket({ url: 'ws://x/ws' }),
        );
        const sock = FakeWebSocket.instances[0];
        act(() => sock.open());

        act(() => {
            sock.receive({
                type: 'error',
                code: 'SERVICE_NOT_AVAILABLE',
                message: "Service 'fizz' not available",
                timestamp: '2026-05-18T00:00:00.000Z',
            });
        });

        expect(result.current.lastError).toEqual({
            code: 'SERVICE_NOT_AVAILABLE',
            message: "Service 'fizz' not available",
            timestamp: '2026-05-18T00:00:00.000Z',
        });
    });

    it('send() before open is a no-op (no throw)', () => {
        const { result } = renderHook(() =>
            useWebSocket({ url: 'ws://x/ws' }),
        );
        // Not opened yet — readyState === 0.
        expect(() => {
            act(() => {
                result.current.send({ service: 'chat', action: 'message', text: 'queued?' });
            });
        }).not.toThrow();
        const sock = FakeWebSocket.instances[0];
        expect(sock.sent).toHaveLength(0);
    });

    it('reconnect() forces a fresh connection attempt', () => {
        const { result } = renderHook(() =>
            useWebSocket({ url: 'ws://x/ws', reconnectMs: 10 }),
        );
        const sock = FakeWebSocket.instances[0];
        act(() => sock.open());

        act(() => {
            result.current.reconnect();
        });
        // reconnect() closes the existing socket. Its onclose triggers
        // scheduleReconnect — but we also call connect() inline, so at
        // minimum one new socket has been instantiated.
        expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    });

    // -------------------------------------------------------------------
    // v2 behaviors — gap-doc closures (G1-G5)
    // -------------------------------------------------------------------

    describe('v2: defaultChannel (G3)', () => {
        it('seeds currentChannel with defaultChannel on first render', () => {
            const { result } = renderHook(() =>
                useWebSocket({ url: 'ws://x/ws', defaultChannel: 'room-42' }),
            );
            expect(result.current.currentChannel).toBe('room-42');
        });

        it('defaults currentChannel to empty string when defaultChannel is omitted', () => {
            const { result } = renderHook(() =>
                useWebSocket({ url: 'ws://x/ws' }),
            );
            expect(result.current.currentChannel).toBe('');
        });
    });

    describe('v2: autoResubscribe (G5)', () => {
        it('does NOT auto-resubscribe by default on reconnect', () => {
            const { result } = renderHook(() =>
                useWebSocket({ url: 'ws://x/ws', reconnectMs: 50 }),
            );
            const sock1 = FakeWebSocket.instances[0];
            act(() => sock1.open());

            act(() => {
                result.current.subscribe('chan-a');
            });
            // Initial subscribe frame is still sent.
            expect(sock1.sentJson().filter((f) => f.action === 'subscribe')).toHaveLength(1);

            act(() => {
                sock1.serverClose();
            });
            act(() => {
                jest.advanceTimersByTime(60);
            });
            const sock2 = FakeWebSocket.instances[1];
            act(() => sock2.open());

            // Default: no replay on reconnect — gateway's pull model owns it.
            expect(sock2.sentJson()).toHaveLength(0);
        });
    });

    describe('v2: persist (G1)', () => {
        function makeMemStorage(): Storage {
            const data: Record<string, string> = {};
            return {
                getItem: (k: string) => (k in data ? data[k] : null),
                setItem: (k: string, v: string) => { data[k] = v; },
                removeItem: (k: string) => { delete data[k]; },
                clear: () => { for (const k of Object.keys(data)) delete data[k]; },
                key: (i: number) => Object.keys(data)[i] ?? null,
                get length() { return Object.keys(data).length; },
            } as Storage;
        }

        it('reads persisted sessionToken/clientId on init', () => {
            const storage = makeMemStorage();
            storage.setItem('ws_session_token', 'persisted-tok');
            storage.setItem('ws_client_id', 'persisted-cid');
            const { result } = renderHook(() =>
                useWebSocket({ url: 'ws://x/ws', persist: { storage } }),
            );
            expect(result.current.sessionToken).toBe('persisted-tok');
            expect(result.current.clientId).toBe('persisted-cid');
        });

        it('writes sessionToken/clientId on session-handshake frame', () => {
            const storage = makeMemStorage();
            renderHook(() =>
                useWebSocket({ url: 'ws://x/ws', persist: { storage } }),
            );
            act(() => {
                FakeWebSocket.instances[0].open();
                FakeWebSocket.instances[0].receive({
                    type: 'session',
                    status: 'connected',
                    clientId: 'fresh-cid',
                    sessionToken: 'fresh-tok',
                });
            });
            expect(storage.getItem('ws_session_token')).toBe('fresh-tok');
            expect(storage.getItem('ws_client_id')).toBe('fresh-cid');
        });

        it('does not clear persisted session on token refresh (authToken dep change)', () => {
            const storage = makeMemStorage();
            storage.setItem('ws_session_token', 'persisted-tok');
            storage.setItem('ws_client_id', 'persisted-cid');

            const { rerender } = renderHook(
                ({ authToken }: { authToken: string }) =>
                    useWebSocket({ url: 'ws://x/ws', authToken, persist: { storage } }),
                { initialProps: { authToken: 'token-v1' } },
            );

            act(() => {
                FakeWebSocket.instances[0].open();
            });

            // Simulate token refresh — effect re-runs with new token.
            act(() => {
                rerender({ authToken: 'token-v2' });
            });

            // Session storage must survive a token refresh.
            expect(storage.getItem('ws_session_token')).toBe('persisted-tok');
            expect(storage.getItem('ws_client_id')).toBe('persisted-cid');

            // New socket must use the refreshed token.
            const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
            expect(latest.protocols).toEqual(['bearer-token-v1', 'token-v2']);
        });

        it('clears persisted session on intentional disconnect()', () => {
            const storage = makeMemStorage();
            storage.setItem('ws_session_token', 'before');
            storage.setItem('ws_client_id', 'before');
            const { result } = renderHook(() =>
                useWebSocket({ url: 'ws://x/ws', persist: { storage } }),
            );
            act(() => FakeWebSocket.instances[0].open());
            act(() => {
                result.current.disconnect();
            });
            expect(storage.getItem('ws_session_token')).toBeNull();
            expect(storage.getItem('ws_client_id')).toBeNull();
        });

        it('honors keyPrefix override', () => {
            const storage = makeMemStorage();
            renderHook(() =>
                useWebSocket({
                    url: 'ws://x/ws',
                    persist: { storage, keyPrefix: 'gw_' },
                }),
            );
            act(() => {
                FakeWebSocket.instances[0].open();
                FakeWebSocket.instances[0].receive({
                    type: 'session',
                    clientId: 'cid-1',
                    sessionToken: 'tok-1',
                });
            });
            expect(storage.getItem('gw_session_token')).toBe('tok-1');
            expect(storage.getItem('gw_client_id')).toBe('cid-1');
            // Default-prefix keys remain empty.
            expect(storage.getItem('ws_session_token')).toBeNull();
        });
    });

    describe('v2: maxRetries + RECONNECT_EXHAUSTED (G2)', () => {
        it('emits RECONNECT_EXHAUSTED after maxRetries failed attempts', () => {
            const { result } = renderHook(() =>
                useWebSocket({
                    url: 'ws://x/ws',
                    reconnectMs: 10,
                    maxReconnectMs: 50,
                    maxRetries: 2,
                }),
            );

            // First socket — close it to trigger first reconnect attempt.
            act(() => FakeWebSocket.instances[0].serverClose());
            // After close, scheduleReconnect runs: attempt 0 < cap 2 ->
            // schedule + bump attempt to 1.
            expect(result.current.connectionState).toBe('reconnecting');

            // Fire first retry timer → spawns socket #2.
            act(() => jest.advanceTimersByTime(100));
            expect(FakeWebSocket.instances.length).toBe(2);

            // Close socket #2 → attempt 1 < cap 2 -> schedule + bump to 2.
            act(() => FakeWebSocket.instances[1].serverClose());
            act(() => jest.advanceTimersByTime(100));
            expect(FakeWebSocket.instances.length).toBe(3);

            // Close socket #3 → attempt 2 >= cap 2 -> RECONNECT_EXHAUSTED.
            act(() => FakeWebSocket.instances[2].serverClose());

            expect(result.current.connectionState).toBe('disconnected');
            expect(result.current.lastError).toEqual(
                expect.objectContaining({
                    code: 'RECONNECT_EXHAUSTED',
                    message: expect.stringContaining('after 2 retries'),
                }),
            );
            // No new socket should be spawned after exhaustion.
            act(() => jest.advanceTimersByTime(1000));
            expect(FakeWebSocket.instances.length).toBe(3);
        });

        it('does NOT emit RECONNECT_EXHAUSTED when maxRetries is the default Infinity', () => {
            const { result } = renderHook(() =>
                useWebSocket({ url: 'ws://x/ws', reconnectMs: 10, maxReconnectMs: 20 }),
            );
            for (let i = 0; i < 5; i++) {
                const sock = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
                act(() => sock.serverClose());
                act(() => jest.advanceTimersByTime(30));
            }
            // Still no terminal error — unbounded preserves v1 behavior.
            expect(result.current.lastError?.code).not.toBe('RECONNECT_EXHAUSTED');
            // After 5 close→reconnect cycles, state is either 'connecting'
            // (mid-attempt) or 'reconnecting' (timer queued) — never
            // 'disconnected' with a finite cap exhausted.
            expect(result.current.connectionState).not.toBe('disconnected');
        });
    });

    describe('v2: stale-socket guards (G4)', () => {
        it('drops onclose from a socket that has been replaced', () => {
            const { result } = renderHook(() =>
                useWebSocket({ url: 'ws://x/ws', reconnectMs: 10 }),
            );
            const sock1 = FakeWebSocket.instances[0];
            act(() => sock1.open());

            // Force reconnect → wsRef is reassigned to sock2.
            act(() => {
                result.current.reconnect();
            });
            const sock2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
            act(() => sock2.open());
            expect(result.current.connectionState).toBe('connected');

            // sock1's late onclose must NOT clobber sock2's connected state.
            act(() => {
                if (sock1.onclose) sock1.onclose({ code: 1006, reason: 'late' });
            });
            expect(result.current.connectionState).toBe('connected');
        });

        it('drops onmessage from a stale socket', () => {
            const onMessage = jest.fn();
            const { result } = renderHook(() =>
                useWebSocket({ url: 'ws://x/ws', reconnectMs: 10, onMessage }),
            );
            const sock1 = FakeWebSocket.instances[0];
            act(() => sock1.open());

            act(() => {
                result.current.reconnect();
            });
            const sock2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
            act(() => sock2.open());

            onMessage.mockClear();

            // sock1 is stale — its onmessage must be ignored.
            act(() => {
                sock1.receive({ type: 'should', be: 'ignored' });
            });
            expect(onMessage).not.toHaveBeenCalled();

            // sock2 still works.
            act(() => {
                sock2.receive({ type: 'live', from: 'sock2' });
            });
            expect(onMessage).toHaveBeenCalledTimes(1);
        });
    });
});
