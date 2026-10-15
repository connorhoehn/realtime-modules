import type { PrincipalRevalidation } from '../server/authority/principal';
import type { WsAuthContext } from '../server-ws/types';
export interface TestIdentity {
    id: string;
    /** The persona this was cloned from. */
    from: string;
    grants: Record<string, string[]>;
    /** This identity's own session epoch. */
    epoch: number;
    /** Epoch ms after which the identity reads as a deleted account. */
    expiresAt: number;
}
export interface TestIdentityDirectoryOptions {
    personas: Record<string, {
        grants?: Record<string, string[]>;
    }>;
    /** Defaults to `Date.now`; pass a fake clock to expire clones. */
    now?: () => number;
    /** Clone lifetime, default 2 h. */
    ttlMs?: number;
}
export declare class TestIdentityDirectory {
    private readonly opts;
    private readonly clones;
    private readonly now;
    private readonly ttlMs;
    private seq;
    constructor(opts: TestIdentityDirectoryOptions);
    /** Mint a clone of `persona` with its own id and epoch 1; grants are a snapshot. */
    clone(persona: string, label?: string): TestIdentity;
    /** The live identity, or null once removed or expired. */
    get(id: string): TestIdentity | null;
    /** A tenant/role switch: bumps THIS identity's epoch only. Returns the new epoch. */
    switchContext(id: string, grants?: Record<string, string[]>): number;
    remove(id: string): boolean;
    clear(): void;
    /** The auth context a socket for `id` carries (`userId`, `epoch`, `grants`). */
    context(id: string): WsAuthContext;
    /** For `attachRealtime({ principal })`: current only while the context's epoch is the identity's. */
    principal(): PrincipalRevalidation;
}
//# sourceMappingURL=testIdentities.d.ts.map