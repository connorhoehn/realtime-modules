"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestIdentityDirectory = void 0;
class TestIdentityDirectory {
    opts;
    clones = new Map();
    now;
    ttlMs;
    seq = 0;
    constructor(opts) {
        this.opts = opts;
        this.now = opts.now ?? Date.now;
        this.ttlMs = opts.ttlMs ?? 2 * 60 * 60_000;
    }
    /** Mint a clone of `persona` with its own id and epoch 1; grants are a snapshot. */
    clone(persona, label) {
        const seed = this.opts.personas[persona];
        if (!seed)
            throw new Error(`TestIdentityDirectory: unknown persona '${persona}'`);
        const id = `${persona}~${label ?? ++this.seq}`;
        const identity = {
            id, from: persona, grants: structuredClone(seed.grants ?? {}), epoch: 1, expiresAt: this.now() + this.ttlMs,
        };
        this.clones.set(id, identity);
        return structuredClone(identity);
    }
    /** The live identity, or null once removed or expired. */
    get(id) {
        const found = this.clones.get(id);
        if (!found)
            return null;
        if (found.expiresAt <= this.now()) {
            this.clones.delete(id);
            return null;
        }
        return structuredClone(found);
    }
    /** A tenant/role switch: bumps THIS identity's epoch only. Returns the new epoch. */
    switchContext(id, grants) {
        const found = this.clones.get(id);
        if (!found)
            throw new Error(`TestIdentityDirectory: unknown identity '${id}'`);
        found.epoch += 1;
        if (grants)
            found.grants = structuredClone(grants);
        return found.epoch;
    }
    remove(id) { return this.clones.delete(id); }
    clear() { this.clones.clear(); }
    /** The auth context a socket for `id` carries (`userId`, `epoch`, `grants`). */
    context(id) {
        const found = this.get(id);
        if (!found)
            throw new Error(`TestIdentityDirectory: unknown or expired identity '${id}'`);
        return { userId: found.id, epoch: found.epoch, grants: found.grants };
    }
    /** For `attachRealtime({ principal })`: current only while the context's epoch is the identity's. */
    principal() {
        return {
            revalidate: (ctx) => {
                const found = typeof ctx.userId === 'string' ? this.get(ctx.userId) : null;
                return !!found && found.epoch === ctx['epoch'];
            },
        };
    }
}
exports.TestIdentityDirectory = TestIdentityDirectory;
//# sourceMappingURL=testIdentities.js.map