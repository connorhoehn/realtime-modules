import { type MeetingState } from './types';
export interface MeetingStateStore {
    get(meetingId: string): Promise<MeetingState | null>;
    put(state: MeetingState): Promise<void>;
    delete(meetingId: string): Promise<void>;
}
export declare class InMemoryMeetingStateStore implements MeetingStateStore {
    private readonly states;
    get(meetingId: string): Promise<MeetingState | null>;
    put(state: MeetingState): Promise<void>;
    delete(meetingId: string): Promise<void>;
    /** Test/inspection helper. */
    get size(): number;
}
//# sourceMappingURL=MeetingStateStore.d.ts.map