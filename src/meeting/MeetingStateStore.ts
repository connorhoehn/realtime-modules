// realtime-modules/src/meeting/MeetingStateStore.ts
//
// Where a meeting's coordination state lives. Async so a shared store
// (Redis, DynamoDB) drops in for a multi-replica gateway. The service
// serialises writes per meeting within a process; across processes a shared
// store provides `putIfVersion`, and the service re-reads and re-applies a
// mutation whose write lost the race (0.125.0).

import { cloneState, type MeetingState } from './types';

export interface MeetingStateStore {
    get(meetingId: string): Promise<MeetingState | null>;
    put(state: MeetingState): Promise<void>;
    delete(meetingId: string): Promise<void>;
    /**
     * Write `state` only when the stored version is `expectedVersion`
     * (0 = no state stored). False means another process wrote first; the
     * service then re-reads and retries. A store without it is last-write-wins,
     * which is only safe for a single process.
     */
    putIfVersion?(state: MeetingState, expectedVersion: number): Promise<boolean>;
    /**
     * Other processes share this store. The service then never deletes an
     * idle meeting (a replica with no local subscribers cannot know that no
     * replica has any); the store's own expiry reaps it.
     */
    readonly shared?: boolean;
    /**
     * Every state any process commits, so a replica's synchronous lobby check
     * and its breakout timer follow writes made elsewhere. Returns a stop
     * function. May also deliver this process's own writes.
     */
    watch?(onState: (state: MeetingState) => void): () => void;
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

    async putIfVersion(state: MeetingState, expectedVersion: number): Promise<boolean> {
        const current = this.states.get(state.meetingId)?.version ?? 0;
        if (current !== expectedVersion) return false;
        this.states.set(state.meetingId, cloneState(state));
        return true;
    }

    async delete(meetingId: string): Promise<void> {
        this.states.delete(meetingId);
    }

    /** Test/inspection helper. */
    get size(): number {
        return this.states.size;
    }
}
