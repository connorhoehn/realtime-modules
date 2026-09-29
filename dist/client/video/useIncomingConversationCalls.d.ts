import type { ConversationCallDeclineReason, ConversationCallGateway, IncomingConversationCall } from './conversationCallTypes';
type RingSettled = {
    callId: string;
    how: 'accepted' | 'declined';
};
/** Internal: a ring was answered in this page. */
export declare function announceRingSettled(e: RingSettled): void;
/** Internal: hear rings answered elsewhere in this page. */
export declare function onRingSettled(fn: (e: RingSettled) => void): () => void;
/**
 * An `invite` frame's data as a ring for `selfUserId`, or null when it is not
 * one (your own invite, a document call, an admission, no callId).
 */
export declare function parseConversationInvite(data: Record<string, unknown>, selfUserId: string | null): IncomingConversationCall | null;
export interface UseIncomingConversationCallsOptions {
    /** Defaults to the surrounding GatewaySocketProvider. */
    gateway?: ConversationCallGateway | null;
    self: {
        userId: string | null;
        displayName?: string;
    };
    /** Ring length. Default 60 s (the server's invite TTL). */
    ttlMs?: number;
    /** A ring aged out unanswered — leave a missed-call trace. */
    onMissed?(ring: IncomingConversationCall): void;
    /** The caller hung up before you answered. */
    onCancelled?(ring: IncomingConversationCall): void;
    /** Accept pressed: open the conversation and call its useConversationCall().accept(ring). */
    onAccept?(ring: IncomingConversationCall): void;
    /** Someone admitted a knock you sent: an `invite` with `admit: true`. Join, don't ring. */
    onAdmitted?(info: {
        callId: string;
        lobbyName: string;
        callerId: string;
        callerName: string;
    }): void;
}
export interface UseIncomingConversationCallsResult {
    /** Oldest first. The toast shows `rings[0]`. */
    rings: IncomingConversationCall[];
    accept(ring: IncomingConversationCall): void;
    decline(ring: IncomingConversationCall, reason?: ConversationCallDeclineReason): void;
}
export declare function useIncomingConversationCalls(opts: UseIncomingConversationCallsOptions): UseIncomingConversationCallsResult;
export {};
//# sourceMappingURL=useIncomingConversationCalls.d.ts.map