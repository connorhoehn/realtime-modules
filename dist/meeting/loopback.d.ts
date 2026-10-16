import type { GatewayMessage } from '../client/types';
import { MeetingService } from './MeetingService';
import type { MeetingConfig } from './types';
export interface MeetingLoopbackSocket {
    send(message: Record<string, unknown>): void;
    onMessage(handler: (msg: GatewayMessage) => void): () => void;
}
export interface MeetingLoopback {
    /** The real service, for host-side reads (`getState`, `admitsBreakoutLobby`). */
    service: MeetingService;
    /** A connection for `userId`; pass it to `useMeeting(meetingId, { socket })`. */
    socketFor(clientId: string, userId: string | null, displayName?: string): MeetingLoopbackSocket;
    /** Drop a connection the way a closed socket would (hands go down, rooms stay). */
    disconnect(clientId: string): Promise<void>;
    /** Stop timers and deliveries. */
    dispose(): void;
}
export declare function createMeetingLoopback(config?: MeetingConfig): MeetingLoopback;
//# sourceMappingURL=loopback.d.ts.map