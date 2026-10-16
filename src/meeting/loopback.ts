// realtime-modules/src/meeting/loopback.ts
//
// A whole meeting in one process, no gateway (0.128.0). `createMeetingLoopback`
// runs a real MeetingService behind an in-memory router and hands out one
// socket per simulated client, shaped for `useMeeting(meetingId, { socket })`.
// For Storybook stages, app tests and demos that need the real wire contract
// (authority, ordering, timers) without a server. Frames are delivered on a
// microtask, so a client sees its own write arrive the way it would over a
// socket: after the call that sent it returns. Browser-safe.

import type { GatewayMessage } from '../client/types';
import { MeetingService } from './MeetingService';
import type { MeetingConfig, MeetingRouter } from './types';

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

export function createMeetingLoopback(config: MeetingConfig = {}): MeetingLoopback {
    const users = new Map<string, { userId: string | null; displayName?: string }>();
    const channels = new Map<string, Set<string>>();
    const handlers = new Map<string, Set<(msg: GatewayMessage) => void>>();
    // One connection's frames are handled in the order it sent them.
    const inbound = new Map<string, Promise<void>>();
    let disposed = false;

    const deliver = (clientId: string, message: unknown) => {
        queueMicrotask(() => {
            if (disposed) return;
            for (const h of handlers.get(clientId) ?? []) h(message as GatewayMessage);
        });
    };
    const router: MeetingRouter = {
        sendToClient: (clientId, message) => { deliver(clientId, message); },
        sendToChannel: (channel, message, exclude) => {
            for (const clientId of channels.get(channel) ?? []) if (clientId !== exclude) deliver(clientId, message);
        },
        subscribeToChannel: (clientId, channel) => {
            const set = channels.get(channel) ?? new Set<string>();
            set.add(clientId);
            channels.set(channel, set);
            return true;
        },
        unsubscribeFromChannel: (clientId, channel) => { channels.get(channel)?.delete(clientId); },
        getUserIdForClient: (clientId) => users.get(clientId)?.userId ?? undefined,
        getClientData: (clientId) => {
            const u = users.get(clientId);
            return u ? { userContext: { userId: u.userId ?? undefined, displayName: u.displayName } } : null;
        },
    };
    const service = new MeetingService({ router, config });

    return {
        service,
        socketFor(clientId, userId, displayName) {
            users.set(clientId, { userId, displayName });
            return {
                send(message) {
                    if (disposed) return;
                    const { service: _service, action, ...data } = message as { service?: unknown; action?: unknown } & Record<string, unknown>;
                    const prev = inbound.get(clientId) ?? Promise.resolve();
                    inbound.set(clientId, prev.then(() => (disposed ? undefined : service.handleAction(clientId, String(action), data))).catch(() => undefined));
                },
                onMessage(handler) {
                    const set = handlers.get(clientId) ?? new Set();
                    set.add(handler);
                    handlers.set(clientId, set);
                    return () => { set.delete(handler); };
                },
            };
        },
        async disconnect(clientId) {
            handlers.delete(clientId);
            for (const set of channels.values()) set.delete(clientId);
            await service.onClientDisconnect(clientId);
            users.delete(clientId);
        },
        dispose() {
            disposed = true;
            service.dispose();
            handlers.clear();
            channels.clear();
        },
    };
}
