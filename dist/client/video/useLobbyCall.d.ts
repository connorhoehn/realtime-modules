import type { GatewayMessage } from '../types';
import type { CallLobbyOccupancy } from '../../call/types';
export type { CallLobbyOccupancy } from '../../call/types';
export interface UseLobbyCallOptions {
    /** Set false to hold the subscription. Default true. */
    enabled?: boolean;
    /** Send/receive handles when the caller owns the socket (see useMeeting). */
    socket?: {
        send: (message: Record<string, unknown>) => void;
        onMessage: (handler: (msg: GatewayMessage) => void) => () => void;
        /** Bumps on every new gateway session; the hook watches again. */
        sessionEpoch?: number;
    };
}
export interface UseLobbyCallResult {
    /** A call is live in this lobby. */
    live: boolean;
    callId: string | null;
    /** Distinct people in the call. */
    participantUserIds: string[];
    /** `participantUserIds.length`. */
    count: number;
    /** ISO time the call started, when the server knows it. */
    startedAt: string | null;
}
/**
 * A `lobby-occupancy` frame's data, checked; null when it is not one. Shared
 * with useConversationCall's discovery.
 */
export declare function parseLobbyOccupancy(data: unknown): CallLobbyOccupancy | null;
export declare function useLobbyCall(lobbyName: string | null | undefined, opts?: UseLobbyCallOptions): UseLobbyCallResult;
//# sourceMappingURL=useLobbyCall.d.ts.map