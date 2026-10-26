/** Saved configuration only. Assignments grant neither access nor live presence. */
export interface SavedHangoutRoom {
    id: string;
    name: string;
    members: string[];
}
export interface HangoutPlanContent {
    mode: 'assigned' | 'self-select';
    allowReturnToMain: boolean;
    rooms: SavedHangoutRoom[];
}
export interface HangoutPlanInput extends HangoutPlanContent {
    /** Compare with the persisted version atomically at the write, not only at validation. */
    expectedVersion: number;
}
export interface HangoutPlan extends HangoutPlanContent {
    version: number;
    /** Host-stamped metadata, never trusted from write input. */
    updatedAt: string;
    updatedBy: string;
}
export declare const HANGOUT_PLAN_LIMITS: Readonly<{
    rooms: 50;
    assignments: 500;
    roomId: 64;
    name: 80;
    memberId: 128;
}>;
export declare class HangoutPlanValidationError extends Error {
    constructor(message: string);
}
/** Structural validation only: no clock, identity provider, network or framework. */
export declare function parseHangoutPlanInput(input: unknown): HangoutPlanInput;
//# sourceMappingURL=plan.d.ts.map