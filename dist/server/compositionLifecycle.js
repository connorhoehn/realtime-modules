"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompositionLifecycle = exports.RealtimeStartupError = void 0;
exports.serviceCleanup = serviceCleanup;
/** Synchronous attachment still throws synchronously; callers can await rollback. */
class RealtimeStartupError extends Error {
    cleanup;
    constructor(cause, cleanup) {
        super(`Realtime startup failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        this.cleanup = cleanup;
        this.name = 'RealtimeStartupError';
    }
}
exports.RealtimeStartupError = RealtimeStartupError;
/** Register each acquisition immediately; rollback and normal disposal share one path. */
class CompositionLifecycle {
    resources = [];
    completion;
    add(name, cleanup) {
        if (this.completion)
            throw new Error('Realtime composition is already disposing');
        if (typeof cleanup !== 'function')
            throw new Error(`Invalid cleanup for '${name}'`);
        this.resources.push({ name, cleanup });
    }
    close() {
        // Schedule after caching the promise so reentrant/repeated calls share it.
        return this.completion ??= Promise.resolve().then(async () => {
            const failures = [];
            for (const resource of this.resources.splice(0).reverse()) {
                try {
                    await resource.cleanup();
                }
                catch (error) {
                    failures.push({ resource: resource.name, error });
                }
            }
            return failures;
        });
    }
    disposer() {
        let completion;
        return () => completion ??= this.close().then(failures => {
            if (failures.length)
                throw new AggregateError(failures.map(f => f.error), `Realtime cleanup failed: ${failures.map(f => f.resource).join(', ')}`);
        });
    }
}
exports.CompositionLifecycle = CompositionLifecycle;
function serviceCleanup(service) {
    return () => {
        const s = service;
        if (typeof s?.shutdown === 'function')
            return s.shutdown();
        if (typeof s?.stop === 'function')
            return s.stop();
    };
}
//# sourceMappingURL=compositionLifecycle.js.map