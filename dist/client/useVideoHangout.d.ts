export interface HangoutParticipant {
    clientId: string;
    displayName?: string;
    role: 'host' | 'participant' | 'viewer';
    videoOn: boolean;
    audioOn: boolean;
    joinedAt: string;
}
export interface HangoutSession {
    id: string;
    type: string;
    createdAt: string;
}
export interface UseVideoHangoutResult {
    session: HangoutSession | null;
    participants: HangoutParticipant[];
    joinToken: string | null;
    start(opts?: {
        type?: 'hangout' | 'call';
        metadata?: Record<string, unknown>;
    }): Promise<void>;
    join(sessionId: string): Promise<void>;
    leave(): Promise<void>;
    end(): Promise<void>;
    toggleVideo(): void;
    toggleAudio(): void;
}
export declare function useVideoHangout(channel: string): UseVideoHangoutResult;
//# sourceMappingURL=useVideoHangout.d.ts.map