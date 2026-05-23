export interface LVSRecordingSegment {
    key: string;
    url: string;
    size: number;
}
export interface LVSRecording {
    recordingId: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    segments: LVSRecordingSegment[];
    destination: 'local' | 's3' | string;
    totalSize?: number;
    /** Optional fields decorated by platform-api when fetched via /api/recordings */
    callId?: string;
    lobbyName?: string;
    channelArn?: string;
    participants?: Array<{
        userId: string;
        displayName?: string;
    }>;
}
export interface UseLVSRecordingsOptions {
    /** Channel ARN to list recordings for. Null = idle, no fetch. */
    channelArn: string | null;
    /** Override base URL (else pulled from LVSProvider). */
    baseUrl?: string;
    /** Optional bearer token (publisher streamKey or admin token). */
    authToken?: string;
}
export interface UseLVSRecordingsResult {
    recordings: LVSRecording[];
    isLoading: boolean;
    error: string | null;
    refetch: () => void;
}
export declare function useLVSRecordings(opts: UseLVSRecordingsOptions): UseLVSRecordingsResult;
//# sourceMappingURL=useLVSRecordings.d.ts.map