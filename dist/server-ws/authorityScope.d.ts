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
/** Clock tolerance a peer allows for a publish proof stamped in its future. */
export declare const PUBLISH_PROOF_SKEW_MS = 250;
/** The scope memo key of one (channel, clientId) publish proof. */
export declare function publishProofKey(channel: string, clientId: string): string;
/**
 * The operation's publish decision for (clientId, channel), asking `ask()`
 * only when there is no live proof for this exact context younger than
 * `maxAgeMs` (P1-P4). Returns `ask()`'s raw decision; callers apply their
 * own per-check fences. With an inactive scope or `maxAgeMs <= 0` this is
 * just `ask()`.
 */
export declare function sharePublishProof(scope: AuthorityScope | null | undefined, clientId: string, channel: string, context: unknown, maxAgeMs: number, ask: () => boolean | Promise<boolean>): boolean | Promise<boolean>;
/**
 * Drop publish proofs from a running operation (P4): every proof in the
 * scope, or only those for `channel` (the exact channel string the router
 * authorized, e.g. `presence:<ch>` for presence). Returns how many dropped.
 */
export declare function revokePublishProofs(scope: AuthorityScope | null | undefined, channel?: string): number;
/**
 * Start time of a live, settled, ALLOWED publish proof for (clientId,
 * channel) that is still younger than `maxAgeMs` — the peer marker (P5) —
 * or null.
 */
export declare function publishProofStartedAt(scope: AuthorityScope | null | undefined, clientId: string, channel: string, maxAgeMs: number): number | null;
/** P5, the peer side: may a peer skip the sender-side publish re-check? */
export declare function acceptsOriginPublishProof(proofAt: unknown, maxAgeMs: number, now?: number): boolean;
//# sourceMappingURL=authorityScope.d.ts.map