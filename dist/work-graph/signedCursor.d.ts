import type { WorkGraphCursorClaims, WorkGraphQueryScope } from './contracts';
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
/** Shared issuer/verifier used by the platform snapshot API and gateway. */
export declare class WorkGraphCursorCodec {
    private readonly secret;
    private readonly now;
    private readonly maximumAgeMs;
    constructor(options: WorkGraphCursorCodecOptions);
    issue(input: IssueWorkGraphCursorInput): string;
    verify(token: string, expectedScope?: WorkGraphQueryScope): WorkGraphCursorClaims;
}
export declare const WORK_GRAPH_REPLAY_MAX_AGE_MS: number;
//# sourceMappingURL=signedCursor.d.ts.map