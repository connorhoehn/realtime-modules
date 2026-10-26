export type RealtimeCleanup = () => void | Promise<void>;

export interface RealtimeCleanupFailure {
    resource: string;
    error: unknown;
}

/** Synchronous attachment still throws synchronously; callers can await rollback. */
export class RealtimeStartupError extends Error {
    constructor(cause: unknown, readonly cleanup: Promise<readonly RealtimeCleanupFailure[]>) {
        super(`Realtime startup failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        this.name = 'RealtimeStartupError';
    }
}

/** Register each acquisition immediately; rollback and normal disposal share one path. */
export class CompositionLifecycle {
    private readonly resources: Array<{ name: string; cleanup: RealtimeCleanup }> = [];
    private completion?: Promise<readonly RealtimeCleanupFailure[]>;

    add(name: string, cleanup: RealtimeCleanup): void {
        if (this.completion) throw new Error('Realtime composition is already disposing');
        if (typeof cleanup !== 'function') throw new Error(`Invalid cleanup for '${name}'`);
        this.resources.push({ name, cleanup });
    }

    close(): Promise<readonly RealtimeCleanupFailure[]> {
        // Schedule after caching the promise so reentrant/repeated calls share it.
        return this.completion ??= Promise.resolve().then(async () => {
            const failures: RealtimeCleanupFailure[] = [];
            for (const resource of this.resources.splice(0).reverse()) {
                try { await resource.cleanup(); }
                catch (error) { failures.push({ resource: resource.name, error }); }
            }
            return failures;
        });
    }

    disposer(): () => Promise<void> {
        let completion: Promise<void> | undefined;
        return () => completion ??= this.close().then(failures => {
            if (failures.length) throw new AggregateError(failures.map(f => f.error),
                `Realtime cleanup failed: ${failures.map(f => f.resource).join(', ')}`);
        });
    }
}

export function serviceCleanup(service: unknown): RealtimeCleanup {
    return () => {
        const s = service as { shutdown?: RealtimeCleanup; stop?: RealtimeCleanup };
        if (typeof s?.shutdown === 'function') return s.shutdown();
        if (typeof s?.stop === 'function') return s.stop();
    };
}
