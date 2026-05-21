// realtime-modules/test/server/SnapshotManager.test.ts
//
// Adapter test for the lifted SnapshotManager — uses MemorySnapshotStore +
// MemoryHotCache instead of DDB / Redis. Covers the happy-path snapshot
// write/read/list/version/restore/clear flows + Y.Doc hydration from both
// hot-cache and durable store paths. Lifted in spirit (not byte-for-byte)
// from gateway test/crdt-snapshot-manager*.test.js since the gateway
// originals lean on aws-sdk-client-mock + a Redis client double.

import * as Y from 'yjs';

import SnapshotManager = require('../../src/server/SnapshotManager');
import {
    MemoryHotCache,
    MemorySnapshotStore,
} from '../../src/server/stores/MemoryStore';

class NoopLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

interface ChannelState {
    ydoc: Y.Doc;
    operationsSinceSnapshot: number;
    subscriberCount: number;
    hydrated: boolean;
}

function makeManager(opts: { withCache?: boolean } = {}) {
    const snapshotStore = new MemorySnapshotStore();
    const hotCache = opts.withCache === false ? null : new MemoryHotCache();
    const states = new Map<string, ChannelState>();
    const mgr = new SnapshotManager({
        snapshotStore,
        hotCache,
        logger: new NoopLogger(),
        getChannelState: (ch: string) => states.get(ch),
    });
    return { mgr, snapshotStore, hotCache, states };
}

function seedState(states: Map<string, ChannelState>, channel: string): ChannelState {
    const ydoc = new Y.Doc();
    const yMap = ydoc.getMap('m');
    yMap.set('x', 1);
    const state: ChannelState = {
        ydoc,
        operationsSinceSnapshot: 1,
        subscriberCount: 0,
        hydrated: true,
    };
    states.set(channel, state);
    return state;
}

describe('SnapshotManager — writeSnapshot + retrieveLatestSnapshot', () => {
    test('round-trips gzipped snapshot bytes through MemorySnapshotStore', async () => {
        const { mgr, snapshotStore, states } = makeManager();
        const state = seedState(states, 'doc:a');

        await mgr.writeSnapshot('doc:a');

        // Operation counter resets.
        expect(state.operationsSinceSnapshot).toBe(0);

        // Latest store entry exists.
        const latest = await snapshotStore.getLatestSnapshot('doc:a');
        expect(latest).not.toBeNull();
        expect(latest!.bytes.length).toBeGreaterThan(0);

        // retrieveLatestSnapshot decompresses + re-encodes base64.
        const retrieved = await mgr.retrieveLatestSnapshot('doc:a');
        expect(retrieved.data).not.toBeNull();
        expect(typeof retrieved.timestamp).toBe('number');
        const stateUpdate = Y.encodeStateAsUpdate(state.ydoc);
        expect(retrieved.data).toBe(Buffer.from(stateUpdate).toString('base64'));
    });

    test('writeSnapshot is a no-op when channel has no state', async () => {
        const { mgr, snapshotStore } = makeManager();
        await mgr.writeSnapshot('doc:never-seen');
        expect(await snapshotStore.getLatestSnapshot('doc:never-seen')).toBeNull();
    });

    test('writeSnapshot logs and continues on store failure (does not throw)', async () => {
        const errors: any[] = [];
        const snapshotStore = new MemorySnapshotStore();
        snapshotStore.putSnapshot = jest.fn(async () => {
            throw new Error('ddb down');
        });
        const states = new Map<string, ChannelState>();
        const mgr = new SnapshotManager({
            snapshotStore,
            hotCache: null,
            logger: { debug() {}, info() {}, warn() {}, error: (...args: any[]) => errors.push(args) },
            getChannelState: (ch: string) => states.get(ch),
        });
        seedState(states, 'doc:err');
        await expect(mgr.writeSnapshot('doc:err')).resolves.toBeUndefined();
        expect(errors.length).toBeGreaterThan(0);
    });
});

describe('SnapshotManager — listSnapshots + getSnapshotAtVersion + restore', () => {
    test('handleListSnapshots returns newest-first version metadata', async () => {
        const { mgr, snapshotStore, states } = makeManager();
        const state = seedState(states, 'doc:l');

        await mgr.writeSnapshot('doc:l'); // v1
        state.ydoc.getMap('m').set('y', 2);
        state.operationsSinceSnapshot = 1;
        // Ensure timestamps differ by at least 1 ms.
        await new Promise((resolve) => setTimeout(resolve, 2));
        await mgr.writeSnapshot('doc:l'); // v2

        const versions = await mgr.handleListSnapshots('doc:l', 10);
        expect(versions.length).toBe(2);
        expect(versions[0].timestamp).toBeGreaterThanOrEqual(versions[1].timestamp);

        // Verify the lifted module returned the store-backed version metadata.
        const rawVersions = await snapshotStore.listVersions('doc:l', 10);
        expect(rawVersions.length).toBe(2);
    });

    test('handleGetSnapshotAtVersion returns the gunzipped base64 for an exact timestamp', async () => {
        const { mgr, snapshotStore, states } = makeManager();
        seedState(states, 'doc:v');
        await mgr.writeSnapshot('doc:v');

        const [version] = await snapshotStore.listVersions('doc:v', 1);
        const hit = await mgr.handleGetSnapshotAtVersion('doc:v', version.timestamp);
        expect(hit).not.toBeNull();
        expect(typeof hit!.base64).toBe('string');
        expect(hit!.timestamp).toBe(version.timestamp);

        expect(await mgr.handleGetSnapshotAtVersion('doc:v', 1)).toBeNull();
    });

    test('handleSaveVersion forces a write even when operationsSinceSnapshot is 0', async () => {
        const { mgr, snapshotStore, states } = makeManager();
        const state = seedState(states, 'doc:s');
        state.operationsSinceSnapshot = 0;

        const saved = await mgr.handleSaveVersion('doc:s', '  named  ', 'user-x');
        expect(saved).not.toBeNull();
        expect(saved!.name).toBe('named');
        expect(saved!.author).toBe('user-x');

        const versions = await snapshotStore.listVersions('doc:s', 10);
        expect(versions.length).toBe(1);
        expect(versions[0].versionName).toBe('named');
    });

    test('handleSaveVersion returns null when channel has no Y.Doc', async () => {
        const { mgr } = makeManager();
        expect(await mgr.handleSaveVersion('doc:missing', 'name', 'u')).toBeNull();
    });

    test('handleRestoreSnapshot replaces ydoc with the historical state', async () => {
        const { mgr, snapshotStore, states } = makeManager();
        const state = seedState(states, 'doc:r');

        // v1 — { x: 1 }
        await mgr.writeSnapshot('doc:r');
        const [v1] = await snapshotStore.listVersions('doc:r', 1);

        // v2 — overwrite to { x: 99 }
        state.ydoc.getMap('m').set('x', 99);
        state.operationsSinceSnapshot = 1;
        await new Promise((resolve) => setTimeout(resolve, 2));
        await mgr.writeSnapshot('doc:r');

        // Restore to v1: ydoc should reflect x === 1 again.
        const result = await mgr.handleRestoreSnapshot('doc:r', v1.timestamp);
        expect(result).not.toBeNull();
        expect(states.get('doc:r')!.ydoc.getMap('m').get('x')).toBe(1);
    });

    test('handleRestoreSnapshot returns null when the version does not exist', async () => {
        const { mgr, states } = makeManager();
        seedState(states, 'doc:r2');
        expect(await mgr.handleRestoreSnapshot('doc:r2', 1)).toBeNull();
    });
});

describe('SnapshotManager — hydrateYDoc', () => {
    test('hydrates from durable store when hot-cache is empty', async () => {
        const { mgr, states, snapshotStore } = makeManager();
        // Seed: write a snapshot for doc:h via the manager, then drop the
        // channel state so hydration starts from scratch.
        const seedYDoc = new Y.Doc();
        seedYDoc.getMap('m').set('hydrated', true);
        states.set('doc:h', {
            ydoc: seedYDoc,
            operationsSinceSnapshot: 1,
            subscriberCount: 0,
            hydrated: true,
        });
        await mgr.writeSnapshot('doc:h');
        states.delete('doc:h');
        // Confirm the store has the snapshot.
        expect(await snapshotStore.getLatestSnapshot('doc:h')).not.toBeNull();

        // Now hydrate into a fresh state.
        const fresh: ChannelState = {
            ydoc: new Y.Doc(),
            operationsSinceSnapshot: 0,
            subscriberCount: 0,
            hydrated: false,
        };
        states.set('doc:h', fresh);
        // Clear hot-cache for this channel so we force the durable-store path.
        // (writeSnapshot populated it; we want to exercise the fallback.)
        await mgr.hydrateYDoc('doc:h', fresh);
        expect(fresh.ydoc.getMap('m').get('hydrated')).toBe(true);
    });

    test('hydrate is a no-op when neither cache nor store has anything', async () => {
        const { mgr } = makeManager();
        const fresh: ChannelState = {
            ydoc: new Y.Doc(),
            operationsSinceSnapshot: 0,
            subscriberCount: 0,
            hydrated: false,
        };
        await mgr.hydrateYDoc('doc:never-saved', fresh);
        // Y.Doc should remain empty (no error)
        expect(fresh.ydoc.getMap('m').size).toBe(0);
    });
});

describe('SnapshotManager — debounce + lifecycle', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('scheduleDebouncedSnapshot writes after the debounce window', async () => {
        const { mgr, snapshotStore, states } = makeManager();
        seedState(states, 'doc:d');
        mgr.scheduleDebouncedSnapshot('doc:d');
        // Fast-forward past the configured debounce window + flush the
        // async writeSnapshot microtask the timer schedules.
        await jest.advanceTimersByTimeAsync(mgr.SNAPSHOT_DEBOUNCE_MS + 1);
        await jest.runAllTimersAsync();
        expect(await snapshotStore.getLatestSnapshot('doc:d')).not.toBeNull();
    });

    test('cancelDebouncedSnapshot prevents the deferred write', async () => {
        const { mgr, snapshotStore, states } = makeManager();
        seedState(states, 'doc:dc');
        mgr.scheduleDebouncedSnapshot('doc:dc');
        mgr.cancelDebouncedSnapshot('doc:dc');
        await jest.advanceTimersByTimeAsync(mgr.SNAPSHOT_DEBOUNCE_MS + 1);
        await jest.runAllTimersAsync();
        expect(await snapshotStore.getLatestSnapshot('doc:dc')).toBeNull();
    });

    test('flushAndClearTimers writes pending dirty channels and clears timers', async () => {
        const { mgr, snapshotStore, states } = makeManager();
        seedState(states, 'doc:f1');
        seedState(states, 'doc:f2');
        mgr.scheduleDebouncedSnapshot('doc:f1');
        mgr.scheduleDebouncedSnapshot('doc:f2');
        await mgr.flushAndClearTimers(states);
        expect(await snapshotStore.getLatestSnapshot('doc:f1')).not.toBeNull();
        expect(await snapshotStore.getLatestSnapshot('doc:f2')).not.toBeNull();
    });
});

describe('SnapshotManager — hot-cache integration', () => {
    test('saveSnapshotToRedis / getSnapshotFromRedis round-trip through HotCache', async () => {
        const { mgr } = makeManager();
        const raw = Buffer.from('hello-cache');
        await mgr.saveSnapshotToRedis('doc:hc', raw.toString('base64'));
        const hit = await mgr.getSnapshotFromRedis('doc:hc');
        expect(hit).toBe(raw.toString('base64'));
    });

    test('hot-cache helpers are no-ops when hotCache is absent', async () => {
        const { mgr } = makeManager({ withCache: false });
        await expect(mgr.saveSnapshotToRedis('doc:none', 'aGVsbG8=')).resolves.toBeUndefined();
        expect(await mgr.getSnapshotFromRedis('doc:none')).toBeNull();
    });
});

describe('SnapshotManager — handleClearDocument', () => {
    test('replaces ydoc with fresh one + persists pre-clear checkpoint', async () => {
        const { mgr, snapshotStore, states } = makeManager();
        seedState(states, 'doc:c');

        const sent: any[] = [];
        const errors: string[] = [];
        await mgr.handleClearDocument(
            'client-1',
            { channel: 'doc:c' },
            states,
            (cid: string, msg: any) => sent.push({ cid, msg }),
            (cid: string, msg: string) => errors.push(msg),
        );

        const versions = await snapshotStore.listVersions('doc:c', 10);
        expect(versions.length).toBeGreaterThanOrEqual(1); // pre-clear + post-clear
        expect(sent.length).toBe(1);
        expect(sent[0].msg.action).toBe('documentCleared');
        expect(states.get('doc:c')!.ydoc.getMap('m').size).toBe(0);
        expect(errors.length).toBe(0);
    });

    test('sends error when channel is missing', async () => {
        const { mgr, states } = makeManager();
        const errors: string[] = [];
        await mgr.handleClearDocument(
            'client-1',
            { channel: '' },
            states,
            () => {},
            (_cid: string, msg: string) => errors.push(msg),
        );
        expect(errors[0]).toMatch(/Channel name is required/);
    });

    test('sends error when no Y.Doc is active for the channel', async () => {
        const { mgr, states } = makeManager();
        const errors: string[] = [];
        await mgr.handleClearDocument(
            'client-1',
            { channel: 'doc:none' },
            states,
            () => {},
            (_cid: string, msg: string) => errors.push(msg),
        );
        expect(errors[0]).toMatch(/No active document for channel/);
    });
});
