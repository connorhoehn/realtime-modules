import type { AuthenticatedWorkEvent, WorkProjectionState } from './contracts';
/** Pure, idempotent projection over an already validated source event. */
export declare function projectWorkEvent(current: WorkProjectionState, event: AuthenticatedWorkEvent): WorkProjectionState;
//# sourceMappingURL=projectEvent.d.ts.map