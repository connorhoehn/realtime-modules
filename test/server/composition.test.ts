import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { attachRealtime, defineFeature } from '../../src/server/attach';
import { planRealtimeComposition } from '../../src/server/composition';
import { RealtimeStartupError } from '../../src/server/compositionLifecycle';
import { createRealtimeServer } from '../../src/server/factory';
import { LocalRealtimeRouter } from '../../src/server/router';
import { ChatService } from '../../src/chat/ChatService';
import { PipelineWsManifest } from '../../src/pipeline/manifest';
import { PipelineWsRouter } from '../../src/pipeline/PipelineWsRouter';
import type { RealtimeFeature } from '../../src/server/attach';

const feature = (name: string, dependencies: string[] = [], serviceName?: string): RealtimeFeature => ({
    manifest: { name, version: '1.0.0', dependencies }, serviceName,
    create: jest.fn(() => ({ handleAction() {} })),
});
const permutations = <T>(items: T[]): T[][] => items.length ? items.flatMap((item, i) =>
    permutations(items.filter((_, j) => i !== j)).map(tail => [item, ...tail])) : [[]];

describe('pure composition preflight', () => {
    it('orders every dependency permutation and resolves manifest and wire aliases', () => {
        const root = feature('root', [], 'base');
        const middle = feature('middle', ['base']);
        const leaf = feature('leaf', ['middle']);
        for (const input of permutations([root, middle, leaf])) {
            const plan = planRealtimeComposition(input);
            expect(plan.features).toEqual([root, middle, leaf]);
            expect(plan.serviceName('root')).toBe('base');
            expect(plan.serviceName('base')).toBe('base');
            expect(plan.serviceName('missing')).toBeUndefined();
        }
        expect(root.create).not.toHaveBeenCalled();
    });

    it('keeps input priority among ready independent features', () => {
        const items = [feature('leaf', ['root']), feature('independent'), feature('root')];
        expect(planRealtimeComposition(items).features.map(f => f.manifest.name)).toEqual(['independent', 'root', 'leaf']);
    });

    it.each([
        ['missing', [feature('one', ['absent'])], /missing feature/],
        ['identity', [feature('same', [], 'one'), feature('same', [], 'two')], /duplicate feature/],
        ['wire', [feature('one', [], 'same'), feature('two', [], 'same')], /alias/],
        ['identity shadows wire', [feature('one', [], 'two'), feature('two')], /alias/],
        ['wire shadows identity', [feature('two'), feature('one', [], 'two')], /alias/],
        ['self cycle', [feature('one', ['one'])], /cycle/],
        ['cycle', [feature('one', ['two']), feature('two', ['one'])], /cycle/],
        ['unsafe identity', [feature('__proto__')], /identifier/],
    ] as const)('rejects %s before any factory or listener', (_name, items, message) => {
        const server = http.createServer();
        expect(() => attachRealtime(server, { features: [...items] })).toThrow(message);
        expect(server.listenerCount('upgrade')).toBe(0);
        for (const item of items) expect(item.create).not.toHaveBeenCalled();
    });

    it('uses explicit shared adapter capabilities and fails closed on duplicate providers', () => {
        const item = feature('durable');
        item.manifest.adapterRequirements = [{ provider: 'store', capabilities: ['conditional-write'] }];
        expect(() => planRealtimeComposition([item])).toThrow(/missing-provider/);
        expect(() => planRealtimeComposition([item], [{ id: 'store', capabilities: ['memory'] }])).toThrow(/missing-capability/);
        const store = { id: 'store', capabilities: ['conditional-write'] };
        expect(() => planRealtimeComposition([item], [store, store])).toThrow(/duplicate-provider/);
        expect(planRealtimeComposition([item], [store]).features).toEqual([item]);
    });
});

describe('composition ownership and rollback', () => {
    it('makes dependencies available by either alias during construction', async () => {
        const baseService = { handleAction() {} };
        const base = { ...feature('base', [], 'wire'), create: () => baseService };
        const dependent = feature('dependent', ['base']);
        dependent.create = ({ service }) => {
            expect(service?.('base')).toBe(baseService);
            expect(service?.('wire')).toBe(baseService);
            return { handleAction() {} };
        };
        const handle = attachRealtime(http.createServer(), { features: [dependent, base] });
        expect(Object.keys(handle.services)).toEqual(['wire', 'dependent', 'subscribe']);
        await handle.dispose();
    });

    it('awaits partial-resource rollback and continues after an asynchronous cleanup failure', async () => {
        const order: string[] = [];
        const failedCleanup = new Error('cleanup failed');
        const router = Object.assign(new LocalRealtimeRouter(), { shutdown: async () => { order.push('router'); } });
        const base = defineFeature({ ...feature('base'), create: () => ({ handleAction() {},
            async shutdown() { order.push('base'); },
        }) });
        const broken = defineFeature({ ...feature('broken', ['base']), create: ({ onCleanup }) => {
            onCleanup?.(async () => { await Promise.resolve(); order.push('partial'); throw failedCleanup; });
            throw new Error('factory failed');
        } });
        const server = http.createServer();
        let failure!: RealtimeStartupError;
        try { attachRealtime(server, { features: [broken, base], router }); }
        catch (error) { failure = error as RealtimeStartupError; }
        expect(failure).toBeInstanceOf(RealtimeStartupError);
        expect(failure.cause).toEqual(new Error('factory failed'));
        expect(await failure.cleanup).toEqual([{ resource: 'broken resource', error: failedCleanup }]);
        expect(order).toEqual(['partial', 'base', 'router']);
        expect(server.listenerCount('upgrade')).toBe(0);
    });

    it('removes a handler installed before router binding fails', async () => {
        const server = http.createServer();
        const router = new LocalRealtimeRouter();
        jest.spyOn(router, '_setHandle').mockImplementation(() => { throw new Error('bind'); });
        const stop = jest.fn();
        const item = { ...feature('one'), create: () => ({ handleAction() {}, stop }) };
        let failure!: RealtimeStartupError;
        try { attachRealtime(server, { features: [item], router }); }
        catch (error) { failure = error as RealtimeStartupError; }
        expect(await failure.cleanup).toEqual([]);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(server.listenerCount('upgrade')).toBe(0);
    });

    it('rolls back when listener registration itself adds and then throws', async () => {
        const server = http.createServer();
        const original = server.on;
        jest.spyOn(server, 'on').mockImplementation(function (this: http.Server, event: 'upgrade', listener: (...args: any[]) => void) {
            original.call(this, event, listener);
            throw new Error('listener failed');
        });
        const stop = jest.fn();
        let failure!: RealtimeStartupError;
        try { attachRealtime(server, { features: [{ ...feature('one'), create: () => ({ handleAction() {}, stop }) }] }); }
        catch (error) { failure = error as RealtimeStartupError; }
        expect(await failure.cleanup).toEqual([]);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(server.listenerCount('upgrade')).toBe(0);
    });

    it('disposes once in reverse dependency order, reports failures and closes stats', async () => {
        const server = http.createServer();
        const order: string[] = [];
        const router = Object.assign(new LocalRealtimeRouter(), { shutdown: async () => { order.push('router'); } });
        const make = (name: string, dependencies: string[]) => defineFeature({ ...feature(name, dependencies),
            create: ({ onCleanup }) => {
                onCleanup?.(() => { order.push(`${name} resource`); });
                return { handleAction() {}, async shutdown() {
                    expect(server.listenerCount('upgrade')).toBe(0);
                    order.push(name);
                    if (name === 'leaf') throw new Error('leaf failed');
                } };
            },
        });
        const handle = attachRealtime(server, { router, features: [make('leaf', ['base']), make('base', [])] });
        handle.stats(); handle.onStats(() => undefined);
        const first = handle.dispose();
        expect(handle.dispose()).toBe(first);
        await expect(first).rejects.toThrow(/leaf/);
        expect(order).toEqual(['leaf', 'leaf resource', 'base', 'base resource', 'router']);
        await expect(handle.dispose()).rejects.toThrow(/leaf/);
        expect(order).toHaveLength(5);
        expect(() => handle.stats()).toThrow(/disposed/);
        expect(() => handle.onStats(() => undefined)).toThrow(/disposed/);
    });
});

describe('legacy factory parity', () => {
    afterEach(() => jest.restoreAllMocks());

    it('refuses unknown, missing and duplicate declarations before construction', () => {
        const shutdown = jest.spyOn(ChatService.prototype, 'shutdown');
        const server = http.createServer();
        const chat = feature('chat').manifest;
        expect(() => createRealtimeServer([chat, feature('unknown').manifest], {}, { server })).toThrow(/attachRealtime.*defineFeature/);
        expect(() => createRealtimeServer([chat, chat], {}, { server })).toThrow(/duplicate feature/);
        expect(() => createRealtimeServer([feature('chat', ['missing']).manifest], {}, { server })).toThrow(/missing feature/);
        expect(shutdown).not.toHaveBeenCalled();
        expect(server.listenerCount('upgrade')).toBe(0);
    });

    it('maps the exported pipeline manifest and closes services once', async () => {
        const shutdown = jest.spyOn(ChatService.prototype, 'shutdown');
        const pipelineAction = jest.spyOn(PipelineWsRouter.prototype, 'handleAction');
        const handle = createRealtimeServer([feature('chat').manifest, PipelineWsManifest], {}, { server: http.createServer() });
        const first = handle.dispose();
        expect(handle.dispose()).toBe(first);
        await first;
        expect(shutdown).toHaveBeenCalledTimes(1);
        expect(pipelineAction).not.toHaveBeenCalled();
    });

    it('rolls back services when handler options fail', async () => {
        const shutdown = jest.spyOn(ChatService.prototype, 'shutdown');
        let failure!: RealtimeStartupError;
        try { createRealtimeServer([feature('chat').manifest], {}, { server: http.createServer(), maxPayload: 0 }); }
        catch (error) { failure = error as RealtimeStartupError; }
        expect(failure).toBeInstanceOf(RealtimeStartupError);
        expect(await failure.cleanup).toEqual([]);
        expect(shutdown).toHaveBeenCalledTimes(1);
    });
});

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};

describe('real sockets crossing composition shutdown', () => {
    it('refuses an upgrade whose authentication finishes after disposal', async () => {
        const server = http.createServer();
        const entered = deferred(), release = deferred();
        const connected = jest.fn();
        const handle = attachRealtime(server, { features: [], auth: async () => {
            entered.resolve(); await release.promise; return { userId: 'alice' };
        }, onConnect: connected });
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        const port = (server.address() as import('node:net').AddressInfo).port;
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on('error', () => undefined);
        try {
            await entered.promise;
            const closed = new Promise<void>(done => ws.once('close', () => done()));
            await handle.dispose();
            await closed;
            release.resolve();
            await new Promise<void>(done => setImmediate(done));
            expect(connected).not.toHaveBeenCalled();
            expect(handle.listClients()).toEqual([]);
        } finally {
            release.resolve(); ws.terminate(); await handle.dispose();
            await new Promise<void>(done => server.close(() => done()));
        }
    });

    it('finishes registration rollback before shutting down its service', async () => {
        const server = http.createServer();
        const entered = deferred(), release = deferred();
        const order: string[] = [];
        const item = { ...feature('slow'), create: () => ({ handleAction() {},
            async onClientConnect() { entered.resolve(); await release.promise; order.push('connected'); },
            async onClientDisconnect() { order.push('disconnected'); },
            async shutdown() { order.push('shutdown'); },
        }) };
        const handle = attachRealtime(server, { features: [item], pingIntervalMs: 0 });
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        const port = (server.address() as import('node:net').AddressInfo).port;
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on('error', () => undefined);
        try {
            await entered.promise;
            const closed = new Promise<void>(done => ws.once('close', () => done()));
            let done = false;
            const disposal = handle.dispose().then(() => { done = true; });
            await closed;
            expect(done).toBe(false);
            expect(order).toEqual([]);
            release.resolve(); await disposal;
            expect(order).toEqual(['connected', 'disconnected', 'shutdown']);
        } finally {
            release.resolve(); ws.terminate(); await handle.dispose();
            await new Promise<void>(done => server.close(() => done()));
        }
    });
});
