// realtime-modules/src/server-ws/authorityScope.ts
//
// A per-OPERATION authority scope: one object the library creates for one
// fan-out, one inbound action or one chat send, and hands to every channel
// authorization (`attachRealtime({ authorize })` receives it as `scope`) and
// membership read (`ChatMembershipStore.listMembers(channel, { scope })`) that
// operation makes. A host may resolve ONE proof per channel per operation in
// `scope.share(key, compute)` instead of one per recipient / per check.
//
// Why: a chat send asked the host the same membership question ~25 times in
// sequence (publish pre-check, three post-persist publish rechecks, the
// recipient list, one subscribe check per recipient, one notify probe per
// live audience member). Each was a strongly consistent read of the same
// rows a few milliseconds apart.
//
// THE CONTRACT. This is NOT a cache, and must never become one.
//
//   1. Lifetime. A scope lives for one operation. `close()` (the library
//      calls it when the operation ends) clears the memo and turns `share`
//      into a pass-through that computes fresh every time. Nothing in a
//      scope outlives its operation; there is no settled positive answer.
//
//   2. Revocation. A host that memoizes a proof in a scope MUST keep that
//      proof revocable for the rest of the operation: observe membership
//      writes / peer revocation hints from BEFORE the proof's read starts,
//      and when one arrives, either `scope.invalidate(key)` (the next check
//      reads fresh) or make the shared proof itself answer deny. Remaining
//      recipients of a fan-out that is still running are then refused. The
//      library's own fences (connection context, subscription token,
//      admission generation) still run per recipient after every decision,
//      shared or not.
//
//   3. Optional. A host that ignores `scope` gets exactly the old behaviour:
//      one authorize call per check. The library never memoizes a decision
//      itself — it only names the operation.
//
// Scopes nest by reuse, not by stacking: an operation that already holds a
// scope passes it down (`sendToChannel(..., { scope })`), and the router uses
// it rather than opening another. A scope the caller passed in is closed by
// the caller, never by the callee.

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

let nextScopeId = 1;

export function createAuthorityScope(operation: string): AuthorityScope {
    const memo = new Map<unknown, unknown>();
    const closers: Array<() => void> = [];
    let active = true;
    let closing = false;
    let retains = 0;
    const finish = () => {
        if (!active) return;
        active = false;
        memo.clear();
        for (const fn of closers.splice(0)) {
            try { fn(); } catch { /* a host cleanup never fails the operation */ }
        }
    };
    const scope: AuthorityScope = {
        id: nextScopeId++,
        operation,
        get active() { return active; },
        memo,
        share<T>(key: unknown, compute: () => T): T {
            if (!active) return compute();
            if (memo.has(key)) return memo.get(key) as T;
            const value = compute();
            memo.set(key, value);
            if (value && typeof (value as { then?: unknown }).then === 'function') {
                (value as unknown as Promise<unknown>).then(undefined, () => {
                    if (memo.get(key) === value) memo.delete(key);
                });
            }
            return value;
        },
        invalidate(key?: unknown): void {
            if (key === undefined) memo.clear();
            else memo.delete(key);
        },
        onClose(fn: () => void): void {
            if (!active) {
                try { fn(); } catch { /* ignore */ }
                return;
            }
            closers.push(fn);
        },
        retain(): () => void {
            if (!active) return () => undefined;
            retains++;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                retains--;
                if (closing && retains === 0) finish();
            };
        },
        close(): void {
            closing = true;
            if (retains === 0) finish();
        },
    };
    return scope;
}

/** The caller's scope when it is still active, or a new one this call owns. */
export function scopeFor(existing: AuthorityScope | null | undefined, operation: string): { scope: AuthorityScope; owned: boolean } {
    if (existing && existing.active) return { scope: existing, owned: false };
    return { scope: createAuthorityScope(operation), owned: true };
}
