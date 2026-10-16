// realtime-modules/src/meeting/MeetingStateStore.ts
//
// Where a meeting's coordination state lives. Async so a shared store
// (Redis, DynamoDB) drops in for a multi-replica gateway; the service
// serialises writes per meeting within a process, and a shared store must
// provide its own cross-process ordering (compare `version`).

import { cloneState, type MeetingState } from './types';

export interface MeetingStateStore {
    get(meetingId: string): Promise<MeetingState | null>;
    put(state: MeetingState): Promise<void>;
    delete(meetingId: string): Promise<void>;
}

export class InMemoryMeetingStateStore implements MeetingStateStore {
    private readonly states = new Map<string, MeetingState>();

    async get(meetingId: string): Promise<MeetingState | null> {
        const s = this.states.get(meetingId);
        return s ? cloneState(s) : null;
    }

    async put(state: MeetingState): Promise<void> {
        this.states.set(state.meetingId, cloneState(state));
    }

    async delete(meetingId: string): Promise<void> {
        this.states.delete(meetingId);
    }

    /** Test/inspection helper. */
    get size(): number {
        return this.states.size;
    }
}
