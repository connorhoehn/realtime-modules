import type { IsoTimestamp, SharingAudience, SharingSelection, WorkHistoryGrant, WorkSharingGrant } from './contracts';
export declare class SharingRevisionConflictError extends Error {
    constructor();
}
export declare class SharingGrantExpiredError extends Error {
    constructor();
}
export interface NewSharingGrant {
    id: string;
    organizationId: string;
    ownerId: string;
    audience: SharingAudience;
    selection: SharingSelection;
    expiresAt: IsoTimestamp;
    historyGrantId?: string;
}
export type SharingTransition = {
    action: 'pause';
    expectedRevision: number;
} | {
    action: 'resume';
    expectedRevision: number;
} | {
    action: 'stop';
    expectedRevision: number;
} | {
    action: 'expire';
    expectedRevision: number;
};
export declare function createSharingGrant(input: NewSharingGrant, now: IsoTimestamp): WorkSharingGrant;
export declare function transitionSharingGrant<T extends WorkSharingGrant | WorkHistoryGrant>(grant: T, transition: SharingTransition, now: IsoTimestamp): T;
/** Read-time expiry is authoritative; database TTL deletion is only cleanup. */
export declare function effectiveSharingGrant<T extends WorkSharingGrant | WorkHistoryGrant>(grant: T, now: IsoTimestamp): T;
export interface SharingGrantPair {
    current?: WorkSharingGrant;
    history?: WorkHistoryGrant;
}
/** Current and historical disclosure transition independently. */
export declare function transitionSharingPair(pair: SharingGrantPair, target: 'current' | 'history', transition: SharingTransition, now: IsoTimestamp): SharingGrantPair;
//# sourceMappingURL=sharingLifecycle.d.ts.map