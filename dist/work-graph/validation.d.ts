/**
 * Runtime boundary for work-graph wire data.
 *
 * These checks deliberately accept only JSON-shaped, exact contract objects.
 * They are for data received from another process or from a persisted stream;
 * they do not authenticate a producer or authorize a viewer.
 */
import { type AuthenticatedWorkEvent, type WorkGraphDeltaBatch, type WorkGraphSnapshot, type WorkHistoryGrant, type WorkReference, type WorkSharingGrant } from './contracts';
export type ValidationResult<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly errors: readonly string[];
};
export declare function validateAuthenticatedWorkEvent(value: unknown): ValidationResult<AuthenticatedWorkEvent>;
export declare function validateWorkSharingGrant(value: unknown): ValidationResult<WorkSharingGrant>;
export declare function validateWorkHistoryGrant(value: unknown): ValidationResult<WorkHistoryGrant>;
export declare function validateWorkGraphSnapshot(value: unknown): ValidationResult<WorkGraphSnapshot>;
export declare function validateWorkGraphDeltaBatch(value: unknown): ValidationResult<WorkGraphDeltaBatch>;
export declare function validateWorkReference(value: unknown): ValidationResult<WorkReference>;
export declare const isAuthenticatedWorkEvent: (value: unknown) => value is AuthenticatedWorkEvent;
export declare const isWorkSharingGrant: (value: unknown) => value is WorkSharingGrant;
export declare const isWorkHistoryGrant: (value: unknown) => value is WorkHistoryGrant;
export declare const isWorkGraphSnapshot: (value: unknown) => value is WorkGraphSnapshot;
export declare const isWorkGraphDeltaBatch: (value: unknown) => value is WorkGraphDeltaBatch;
export declare const isWorkReference: (value: unknown) => value is WorkReference;
//# sourceMappingURL=validation.d.ts.map