export interface AuthorityScope {
    /** Process-unique id, for logs. */
    readonly id: number;
    /** What the operation is: `fanout`, `chat.send`, `chat.join`, … */
    readonly operation: string;
    /** False once the operation has ended. */
    readonly active: boolean;
    /**
     * The memo itself. Prefer `share`; exposed for hosts that keep richer
     * per-operation state (an observer per channel). Cleared on close.
     */
    readonly memo: Map<unknown, unknown>;
    /**
     * `compute()` once per key while the scope is active; every later call
     * with the same key gets the same value (typically a promise of one
     * proof). After close it always computes fresh and stores nothing. A
     * rejected promise is dropped from the memo so the next caller retries.
     * Keys compare like Map keys (identity): use a string such as
     * `members:<channel>`, not a fresh array.
     */
    share<T>(key: unknown, compute: () => T): T;
    /** Forget one key (or all) — a revocation seen mid-operation. */
    invalidate(key?: unknown): void;
    /** Run `fn` when the scope closes (dispose a host observer). */
    onClose(fn: () => void): void;
    /**
     * Keep the scope open past its operation's own end until the returned
     * release is called — for a tail of the SAME operation, such as the
     * unread probe a send's `onChannelMessage` hook runs. Release is
     * idempotent.
     */
    retain(): () => void;
    /** End the operation. Idempotent; waits for outstanding retains. */
    close(): void;
}
export declare function createAuthorityScope(operation: string): AuthorityScope;
/** The caller's scope when it is still active, or a new one this call owns. */
export declare function scopeFor(existing: AuthorityScope | null | undefined, operation: string): {
    scope: AuthorityScope;
    owned: boolean;
};
//# sourceMappingURL=authorityScope.d.ts.map