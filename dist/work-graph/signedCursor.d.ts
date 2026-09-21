import type { WorkGraphCursorClaims, WorkGraphQueryScope } from './contracts';
import type { WorkGraphCursorClaimsV2, WorkGraphQueryV2 } from './contractsV2';
export type WorkGraphCursorFailure = 'malformed' | 'invalid-signature' | 'invalid-claims' | 'expired' | 'scope-mismatch';
export declare class WorkGraphCursorError extends Error {
    readonly reason: WorkGraphCursorFailure;
    constructor(reason: WorkGraphCursorFailure);
}
export interface WorkGraphCursorCodecOptions {
    secret: string | Buffer;
    now?: () => number;
    maximumAgeMs?: number;
}
export interface IssueWorkGraphCursorInput {
    scope: WorkGraphQueryScope;
    watermark: number;
    subscriptionGeneration: string;
    pageOffset?: string;
    expiresAt?: string;
}
export interface IssueWorkGraphCursorV2Input {
    scope: WorkGraphQueryScope;
    /** The complete authorized query this cursor is bound to. */
    query: WorkGraphQueryV2;
    /**
     * Per-UTC-partition watermarks. A non-UTC local day spans two partitions, so
     * one composite revision number is not a position in either delta log.
     */
    partitions: Array<{
        utcDay: string;
        watermark: number;
    }>;
    /** Composite revision observed when the snapshot was issued. */
    observationWatermark: number;
    subscriptionGeneration: string;
    pageOffset?: string;
    expiresAt?: string;
}
/** Shared issuer/verifier used by the platform snapshot API and gateway. */
export declare class WorkGraphCursorCodec {
    private readonly secret;
    private readonly now;
    private readonly maximumAgeMs;
    constructor(options: WorkGraphCursorCodecOptions);
    issue(input: IssueWorkGraphCursorInput): string;
    /**
     * Issues a composite v2 cursor. The v1 `issue` is untouched, and a v1
     * verifier still rejects this token because the prefix differs.
     */
    issueV2(input: IssueWorkGraphCursorV2Input): string;
    /** Verifies a v2 cursor. A v1 token is rejected here, and the reverse holds. */
    verifyV2(token: string, expectedScope?: WorkGraphQueryScope, expectedQuery?: WorkGraphQueryV2): WorkGraphCursorClaimsV2;
    /** Constant-time signature check shared by both versions. */
    private authenticate;
    private assertFresh;
    verify(token: string, expectedScope?: WorkGraphQueryScope): WorkGraphCursorClaims;
}
export declare const WORK_GRAPH_REPLAY_MAX_AGE_MS: number;
//# sourceMappingURL=signedCursor.d.ts.map