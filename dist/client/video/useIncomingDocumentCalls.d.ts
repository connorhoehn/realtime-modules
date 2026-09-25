import { type DocumentCallGateway } from './documentCallGateway';
export interface IncomingDocumentCallPerson {
    userId: string;
    displayName: string;
    avatarUrl?: string;
}
export interface IncomingDocumentCall {
    callId: string;
    callerId: string;
    callerName: string;
    callerAvatarUrl?: string;
    lobbyName: string;
    /** The invite named this user (not an ambient broadcast). */
    targeted: boolean;
    kind: 'document-review';
    /** Host document. */
    documentId: string;
    title: string;
    documentIds: string[];
    documentTitles?: Record<string, string>;
    message?: string;
    /** People in the call when the invite was sent (for "3 in call"). */
    participantCount: number;
    /** Who is in it, when the caller sent names (avatar stack). */
    participants?: IncomingDocumentCallPerson[];
    media: 'video' | 'audio';
    receivedAt: number;
    expiresAt: number;
}
export interface UseIncomingDocumentCallsOptions {
    gateway?: DocumentCallGateway | null;
    localUserId: string | null;
    /** Ring length. Default 60 s (the server's per-target TTL). */
    ttlMs?: number;
    /** The ring aged out unanswered — leave a missed-call trace. */
    onMissed?(invite: IncomingDocumentCall): void;
    /** Join button: typically `(inv, media) => documentCall.join(inv.callId, media)`. */
    onAccept?(invite: IncomingDocumentCall, media: {
        micOn: boolean;
        cameraOn: boolean;
    }): void;
}
export interface UseIncomingDocumentCallsResult {
    current: IncomingDocumentCall | null;
    /** Everything ringing, oldest first (current is [0]). */
    queue: IncomingDocumentCall[];
    queueLength: number;
    /** Take the current ring: pops it and calls onAccept. Returns it. */
    accept(media: {
        micOn: boolean;
        cameraOn: boolean;
    }): IncomingDocumentCall | null;
    /** Say no (`declined` with a reason goes to the caller) and pop. */
    decline(reason: 'not-now' | 'busy'): void;
    /** Pop without telling anyone (the ring stays unanswered → missed). */
    dismiss(): void;
}
/** Parse an invite frame into an IncomingDocumentCall, or null when it is not
 *  a document-call ring for this user. Exported for tests and custom queues. */
export declare function parseDocumentInvite(data: Record<string, unknown>, localUserId: string | null, ttlMs: number, now?: number): IncomingDocumentCall | null;
export declare function useIncomingDocumentCalls(opts: UseIncomingDocumentCallsOptions): UseIncomingDocumentCallsResult;
//# sourceMappingURL=useIncomingDocumentCalls.d.ts.map