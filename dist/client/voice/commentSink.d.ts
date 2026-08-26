import type { TranscriptReadyEvent } from './transcriptBus';
export interface AttachTranscriptOptions {
    /** platform-api base URL. Empty string means same-origin. */
    apiBaseUrl?: string;
    authToken: string;
    /**
     * Attach even when the context is ambiguous. Only ever set this from an
     * explicit human confirmation — never as a default, and never because a
     * model decided the target looked right.
     */
    confirmed?: boolean;
    fetchImpl?: typeof fetch;
}
export type AttachResult = {
    attached: true;
    commentId: string;
    sectionId: string;
    documentId: string;
} | {
    attached: false;
    reason: AttachRefusal;
    detail: string;
};
export type AttachRefusal = 'context-split' | 'no-target' | 'not-a-document' | 'empty-transcript' | 'transcript-lost' | 'request-failed';
/**
 * Decide whether an utterance may be written without asking a human.
 *
 * Split out from the request so the UI can render the SAME verdict next to the
 * live transcript, before anything is sent. A user should never be surprised by
 * a refusal after the fact.
 */
export declare function evaluateAttach(event: TranscriptReadyEvent, confirmed?: boolean): {
    ok: true;
} | {
    ok: false;
    reason: AttachRefusal;
    detail: string;
};
/**
 * POST the transcript to the existing document-comments endpoint.
 *
 * Uses the endpoint exactly as it already is — no new write path, no new table,
 * no schema change. That is the whole point of picking this sink first.
 */
export declare function attachTranscriptAsComment(event: TranscriptReadyEvent, opts: AttachTranscriptOptions): Promise<AttachResult>;
//# sourceMappingURL=commentSink.d.ts.map