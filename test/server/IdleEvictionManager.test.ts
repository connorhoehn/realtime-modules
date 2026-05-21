// realtime-modules/test/server/IdleEvictionManager.test.ts
//
// Lifted from gateway test/crdt-idle-eviction-manager.test.js.

import IdleEvictionManager = require('../../src/server/IdleEvictionManager');

class NoopLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

const FAST_MS = 100;

function makeManager() {
    return new IdleEvictionManager(new NoopLogger(), { idleEvictionMs: FAST_MS });
}

describe('IdleEvictionManager', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('startEviction fires the callback after the configured delay', async () => {
        const mgr = makeManager();
        const cb = jest.fn().mockResolvedValue(undefined);
        mgr.startEviction('crdt:doc:1', cb);
        expect(cb).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(FAST_MS);
        expect(cb).toHaveBeenCalledWith('crdt:doc:1');
    });

    test('startEviction is idempotent — second call while timer is running is a no-op', async () => {
        const mgr = makeManager();
        const cb = jest.fn().mockResolvedValue(undefined);
        mgr.startEviction('crdt:doc:1', cb);
        mgr.startEviction('crdt:doc:1', cb);
        await jest.advanceTimersByTimeAsync(FAST_MS);
        expect(cb).toHaveBeenCalledTimes(1);
    });

    test('cancelEviction prevents the callback from firing', async () => {
        const mgr = makeManager();
        const cb = jest.fn();
        mgr.startEviction('crdt:doc:1', cb);
        mgr.cancelEviction('crdt:doc:1');
        await jest.advanceTimersByTimeAsync(FAST_MS);
        expect(cb).not.toHaveBeenCalled();
    });

    test('cancelEviction is a no-op when no timer is running', () => {
        const mgr = makeManager();
        expect(() => mgr.cancelEviction('crdt:doc:none')).not.toThrow();
    });

    test('shutdown() clears all timers so no callbacks fire', async () => {
        const mgr = makeManager();
        const cb = jest.fn();
        mgr.startEviction('crdt:doc:A', cb);
        mgr.startEviction('crdt:doc:B', cb);
        expect(mgr.pendingCount).toBe(2);
        mgr.shutdown();
        expect(mgr.pendingCount).toBe(0);
        await jest.advanceTimersByTimeAsync(FAST_MS);
        expect(cb).not.toHaveBeenCalled();
    });

    test('pendingCount reflects active timers', () => {
        const mgr = makeManager();
        expect(mgr.pendingCount).toBe(0);
        mgr.startEviction('crdt:doc:1', jest.fn());
        expect(mgr.pendingCount).toBe(1);
        mgr.cancelEviction('crdt:doc:1');
        expect(mgr.pendingCount).toBe(0);
    });

    test('timer is self-removing: pendingCount drops to 0 after callback fires', async () => {
        const mgr = makeManager();
        const cb = jest.fn().mockResolvedValue(undefined);
        mgr.startEviction('crdt:doc:1', cb);
        await jest.advanceTimersByTimeAsync(FAST_MS);
        expect(mgr.pendingCount).toBe(0);
    });

    test('callback error is swallowed and does not leave a stale timer entry', async () => {
        const mgr = makeManager();
        const cb = jest.fn().mockRejectedValue(new Error('snapshot failed'));
        mgr.startEviction('crdt:doc:1', cb);
        await jest.advanceTimersByTimeAsync(FAST_MS);
        expect(mgr.pendingCount).toBe(0);
    });

    test('constructor uses IDLE_EVICTION_MS default when no config is supplied', () => {
        const { IDLE_EVICTION_MS } = require('../../src/server/config');
        const mgr = new IdleEvictionManager(new NoopLogger());
        expect(mgr.IDLE_EVICTION_MS).toBe(IDLE_EVICTION_MS);
    });

    test('constructor uses IDLE_EVICTION_MS default when config omits idleEvictionMs', () => {
        const { IDLE_EVICTION_MS } = require('../../src/server/config');
        const mgr = new IdleEvictionManager(new NoopLogger(), { otherKey: 'ignored' });
        expect(mgr.IDLE_EVICTION_MS).toBe(IDLE_EVICTION_MS);
    });
});
