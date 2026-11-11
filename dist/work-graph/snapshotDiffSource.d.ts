import type { AuthorityScope } from '../server-ws/authorityScope';
import { type WorkGraphDeltaOperation, type WorkGraphSnapshot } from './contracts';
import type { WorkGraphSnapshotV2 } from './contractsV2';
import type { WorkGraphSource, WorkGraphStreamSubscription, WorkGraphStreamTrigger } from './streamService';
export type WorkGraphAnySnapshot = WorkGraphSnapshot | WorkGraphSnapshotV2;
/** Thrown by a host's `snapshot` when the viewer may no longer read this graph. */
export declare class WorkGraphSnapshotRefused extends Error {
    constructor(message?: string);
}
export interface SnapshotDiffSourceContext {
    trigger: WorkGraphStreamTrigger;
    /** The publish operation's AuthorityScope (share authorization reads under its contract). */
    scope: AuthorityScope;
}
export interface SnapshotDiffSourceOptions {
    /**
     * This subscriber's authorized snapshot NOW: the same builder the host's
     * snapshot route uses, for `sub.userContext` and `sub.scope` (and
     * `sub.activity` for a schemaVersion 2 reader). `null` means the scope no
     * longer exists (`reset-required: scope-changed`).
     */
    snapshot(sub: WorkGraphStreamSubscription, ctx: SnapshotDiffSourceContext): WorkGraphAnySnapshot | null | Promise<WorkGraphAnySnapshot | null>;
    /** Does `change` (the host's `publish` payload) concern this subscription? Default: yes. */
    concerns?(sub: WorkGraphStreamSubscription, change: unknown): boolean;
    /** Is this `snapshot` error a refusal (→ `invalidate`)? Default: `WorkGraphSnapshotRefused`, or `status` 401/403. */
    isRefusal?(error: unknown): boolean;
    /** The snapshot this viewer was served for `sub.cursor`, if the host kept it (the catch-up baseline). */
    served?(sub: WorkGraphStreamSubscription): WorkGraphAnySnapshot | null | undefined;
    /** The cursor a delta carries. Default: the fresh snapshot's own cursor. */
    cursorFor?(fresh: WorkGraphAnySnapshot, watermark: number): string;
    /** Live subscriptions remembered per connection. Default 8 (the stream service's cap). */
    maxPerClient?: number;
    /** Baselines remembered in total (oldest connection dropped first). Default 4096. */
    maxBaselines?: number;
    /** A repeated catch-up gap within this window is adopted, not re-sent. Default 30 000. */
    gapWindowMs?: number;
    /** Clock, injectable for tests. */
    now?: () => number;
}
export interface SnapshotDiffSource extends WorkGraphSource {
    frames(sub: WorkGraphStreamSubscription, trigger: WorkGraphStreamTrigger, opts: {
        scope: AuthorityScope;
    }): Promise<readonly unknown[]>;
    /** A socket went away: forget every baseline its subscriptions held. */
    forgetClient(clientId: string): void;
    stats(): {
        clients: number;
        baselines: number;
        computed: number;
    };
}
/**
 * The operations that turn `base` into `fresh`, in the order the reader's
 * reducer applies them. Node and edge equality is structural (JSON), so a
 * host should build records with a stable key order.
 */
export declare function diffWorkGraphSnapshots(base: WorkGraphAnySnapshot, fresh: WorkGraphAnySnapshot): WorkGraphDeltaOperation[];
export declare function createSnapshotDiffSource(options: SnapshotDiffSourceOptions): SnapshotDiffSource;
//# sourceMappingURL=snapshotDiffSource.d.ts.map