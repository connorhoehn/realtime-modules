// Epoch-scoped test identities. A real host drops every older session of a
// user when that user's session epoch moves (a tenant or role switch). Two
// parallel runs as the same persona then revoke each other. A clone carries
// the persona's grants under its OWN id and epoch, so a switch on one clone
// revokes nothing else. Generic: no fixtures, no host types.
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
    personas: Record<string, { grants?: Record<string, string[]> }>;
    /** Defaults to `Date.now`; pass a fake clock to expire clones. */
    now?: () => number;
    /** Clone lifetime, default 2 h. */
    ttlMs?: number;
}

export class TestIdentityDirectory {
    private readonly clones = new Map<string, TestIdentity>();
    private readonly now: () => number;
    private readonly ttlMs: number;
    private seq = 0;

    constructor(private readonly opts: TestIdentityDirectoryOptions) {
        this.now = opts.now ?? Date.now;
        this.ttlMs = opts.ttlMs ?? 2 * 60 * 60_000;
    }

    /** Mint a clone of `persona` with its own id and epoch 1; grants are a snapshot. */
    clone(persona: string, label?: string): TestIdentity {
        const seed = this.opts.personas[persona];
        if (!seed) throw new Error(`TestIdentityDirectory: unknown persona '${persona}'`);
        const id = `${persona}~${label ?? ++this.seq}`;
        const identity: TestIdentity = {
            id, from: persona, grants: structuredClone(seed.grants ?? {}), epoch: 1, expiresAt: this.now() + this.ttlMs,
        };
        this.clones.set(id, identity);
        return structuredClone(identity);
    }

    /** The live identity, or null once removed or expired. */
    get(id: string): TestIdentity | null {
        const found = this.clones.get(id);
        if (!found) return null;
        if (found.expiresAt <= this.now()) { this.clones.delete(id); return null; }
        return structuredClone(found);
    }

    /** A tenant/role switch: bumps THIS identity's epoch only. Returns the new epoch. */
    switchContext(id: string, grants?: Record<string, string[]>): number {
        const found = this.clones.get(id);
        if (!found) throw new Error(`TestIdentityDirectory: unknown identity '${id}'`);
        found.epoch += 1;
        if (grants) found.grants = structuredClone(grants);
        return found.epoch;
    }

    remove(id: string): boolean { return this.clones.delete(id); }
    clear(): void { this.clones.clear(); }

    /** The auth context a socket for `id` carries (`userId`, `epoch`, `grants`). */
    context(id: string): WsAuthContext {
        const found = this.get(id);
        if (!found) throw new Error(`TestIdentityDirectory: unknown or expired identity '${id}'`);
        return { userId: found.id, epoch: found.epoch, grants: found.grants };
    }

    /** For `attachRealtime({ principal })`: current only while the context's epoch is the identity's. */
    principal(): PrincipalRevalidation {
        return {
            revalidate: (ctx: WsAuthContext) => {
                const found = typeof ctx.userId === 'string' ? this.get(ctx.userId) : null;
                return !!found && found.epoch === ctx['epoch'];
            },
        };
    }
}
