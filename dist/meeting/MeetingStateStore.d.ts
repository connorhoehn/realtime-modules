import { type MeetingState } from './types';
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
export declare class InMemoryMeetingStateStore implements MeetingStateStore {
    private readonly states;
    get(meetingId: string): Promise<MeetingState | null>;
    put(state: MeetingState): Promise<void>;
    putIfVersion(state: MeetingState, expectedVersion: number): Promise<boolean>;
    delete(meetingId: string): Promise<void>;
    /** Test/inspection helper. */
    get size(): number;
}
//# sourceMappingURL=MeetingStateStore.d.ts.map