import { type DocumentCallGateway } from './documentCallGateway';
import type { AudioVideoSettings, DocumentCallAwarenessParticipant, DocumentCallMediaMember, DocumentCallMeta, DocumentCallParticipant, DocumentCallSession } from './documentCallTypes';
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/** The consumer's LVS session, reported back to the hook. All optional. */
export interface DocumentCallMediaBinding {
    /** e.g. useLVSHangoutShared().connectionState. */
    connectionState?: string;
    members?: DocumentCallMediaMember[];
    activeSpeakerUserId?: string | null;
    setMicEnabled?(on: boolean): void | Promise<void>;
    setCameraEnabled?(on: boolean): void | Promise<void>;
    startScreenShare?(): void | Promise<void>;
    stopScreenShare?(): void | Promise<void>;
}
export interface UseDocumentCallOptions {
    /** The document this page shows. */
    documentId: string;
    /** From useGateway() / the app socket. Defaults to the surrounding GatewayContext. */
    gateway?: DocumentCallGateway | null;
    platformApi: {
        baseUrl: string;
        getAuthHeaders(): Promise<Record<string, string>> | Record<string, string>;
    };
    identity: {
        userId: string;
        displayName: string;
        avatarUrl?: string;
    };
    /** The page's Y awareness, for follow locations. */
    awareness?: {
        participants: DocumentCallAwarenessParticipant[];
    };
    /** From useAudioVideoSettings; carried for the consumer's media layer. */
    settings?: AudioVideoSettings;
    /** A call to resolve even when this document is not its host (invite link `?call=`). */
    callId?: string | null;
    /** The consumer's LVS session (see DocumentCallMediaBinding). */
    media?: DocumentCallMediaBinding | null;
    /** The person you follow now presents `documentId` — go there. */
    onNavigate?(documentId: string): void;
    /** Y.Doc meta writer for `activeCallSessionId` (useVideoCall's contract). */
    updateDocumentMeta?(partial: {
        activeCallSessionId: string;
    }): void;
    /** Names/avatars for invitees who are not in the call yet. */
    people?: Record<string, {
        displayName: string;
        avatarUrl?: string;
    }>;
    /** Origin for `inviteLink`. Default window.location.origin. */
    linkBase?: string;
    /** Injectable for tests. */
    fetch?: typeof fetch;
    /** Where the follow target lives. Default sessionStorage (per tab); null = memory. */
    followStorage?: StorageLike | null;
    /** How long a `left` person stays in the list. Default 30 s. */
    leftLingerMs?: number;
    /** How long `ended` shows before the phase returns to idle. Default 10 s. */
    endedHoldMs?: number;
}
export type DocumentCallPhase = 'idle' | 'starting' | 'connecting' | 'active' | 'reconnecting' | 'ended' | 'error';
export interface DocumentCallStartInput {
    title: string;
    media: 'video' | 'audio';
    documentIds: string[];
    /** id → title for the review list, so the invite and joiners can label rows. */
    documentTitles?: Record<string, string>;
    targetUserIds: string[];
    message?: string;
    ring: boolean;
    micOn: boolean;
    cameraOn: boolean;
}
export type DocumentCall = DocumentCallSession & DocumentCallMeta;
export interface UseDocumentCallResult {
    /** The call this document is part of, joined or not. */
    call: DocumentCall | null;
    phase: DocumentCallPhase;
    joined: boolean;
    isHost: boolean;
    elapsedMs: number | null;
    error: {
        message: string;
        retry(): void;
    } | null;
    /** How the last call ended, while phase is 'ended'. */
    ended: {
        at: number;
        durationMs: number | null;
        reason: string;
    } | null;
    participants: DocumentCallParticipant[];
    /** People in the call now (in-call + reconnecting) — "4 people". */
    inCallCount: number;
    activeSpeakerId: string | null;
    self: {
        audioOn: boolean;
        cameraOn: boolean;
        screenSharing: boolean;
    };
    start(input: DocumentCallStartInput): Promise<void>;
    join(callId: string, media: {
        micOn: boolean;
        cameraOn: boolean;
    }): Promise<void>;
    leave(): Promise<void>;
    endForEveryone(): Promise<void>;
    invite(userIds: string[], message?: string): void;
    ringAgain(userId: string): void;
    setDocuments(documentIds: string[], documentTitles?: Record<string, string>): Promise<void>;
    setTitle(title: string): Promise<void>;
    present(documentId: string | null): void;
    following: {
        userId: string;
        location: DocumentCallParticipant['location'] | null;
    } | null;
    follow(userId: string | null): void;
    toggleMic(): void;
    toggleCamera(): void;
    startScreenShare(): void;
    stopScreenShare(): void;
    /** For LVSHangoutSessionProvider. */
    lvs: {
        stageToken: string | null;
        participantId: string | null;
        sessionId: string | null;
    };
    inviteLink: string;
    /** Re-read the record and live state (after a navigation, say). */
    refresh(): void;
    /** Host only: ask this person to mute (their client mutes itself). */
    muteParticipant(userId: string): void;
    /** Host only: remove this person; they can come back only through a new invite. */
    removeParticipant(userId: string): void;
    /** Host only: hand the host role to this participant. */
    transferHost(userId: string): void;
    /** "Mute for me": silence this person locally only. Reflected as `participant.mutedForMe`. */
    setMutedForMe(userId: string, muted: boolean): void;
    /** The last thing the host did to you — for a toast ("Connor muted you"). */
    moderation: {
        kind: 'muted' | 'removed';
        by: string;
        at: number;
    } | null;
}
/** A platform-api video-session row → DocumentCallSession (lenient: rows from
 *  before `kind` existed still parse, as the host document's call). */
export declare function toDocumentCallSession(row: Record<string, unknown>): DocumentCallSession | null;
/** Session + meta → one call object. Meta (live) wins over the record. */
export declare function mergeDocumentCall(session: DocumentCallSession | null, meta: DocumentCallMeta | null): DocumentCall | null;
export declare function useDocumentCall(opts: UseDocumentCallOptions): UseDocumentCallResult;
export {};
//# sourceMappingURL=useDocumentCall.d.ts.map