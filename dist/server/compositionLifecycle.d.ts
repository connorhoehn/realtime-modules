export type RealtimeCleanup = () => void | Promise<void>;
export interface RealtimeCleanupFailure {
    resource: string;
    error: unknown;
}
/** Synchronous attachment still throws synchronously; callers can await rollback. */
export declare class RealtimeStartupError extends Error {
    readonly cleanup: Promise<readonly RealtimeCleanupFailure[]>;
    constructor(cause: unknown, cleanup: Promise<readonly RealtimeCleanupFailure[]>);
}
/** Register each acquisition immediately; rollback and normal disposal share one path. */
export declare class CompositionLifecycle {
    private readonly resources;
    private completion?;
    add(name: string, cleanup: RealtimeCleanup): void;
    close(): Promise<readonly RealtimeCleanupFailure[]>;
    disposer(): () => Promise<void>;
}
export declare function serviceCleanup(service: unknown): RealtimeCleanup;
//# sourceMappingURL=compositionLifecycle.d.ts.map