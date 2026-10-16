// Fake router for MeetingService unit tests: records every frame per client
// and per channel, and lets a test refuse channel subscriptions.

import type { MeetingRouter } from '../../src/meeting/types';

export interface FakeRouter extends MeetingRouter {
    users: Map<string, string>;
    names: Map<string, string>;
    subs: Map<string, Set<string>>;
    toClient: Map<string, any[]>;
    deny: Set<string>;
    framesFor(clientId: string, action?: string): any[];
    last(clientId: string, action: string): any;
}

export function fakeRouter(): FakeRouter {
    const users = new Map<string, string>();
    const names = new Map<string, string>();
    const subs = new Map<string, Set<string>>();
    const toClient = new Map<string, any[]>();
    const deny = new Set<string>();
    const push = (clientId: string, frame: unknown) => {
        const list = toClient.get(clientId) ?? [];
        list.push(frame);
        toClient.set(clientId, list);
    };
    const r: FakeRouter = {
        users, names, subs, toClient, deny,
        sendToClient: (clientId, message) => { push(clientId, message); },
        sendToChannel: (channel, message) => {
            for (const [clientId, chans] of subs) if (chans.has(channel)) push(clientId, message);
        },
        subscribeToChannel: (clientId, channel) => {
            if (deny.has(clientId)) return false;
            const set = subs.get(clientId) ?? new Set<string>();
            set.add(channel);
            subs.set(clientId, set);
            return true;
        },
        unsubscribeFromChannel: (clientId, channel) => { subs.get(clientId)?.delete(channel); },
        getUserIdForClient: (clientId) => users.get(clientId),
        getClientData: (clientId) => ({ userContext: { userId: users.get(clientId), displayName: names.get(clientId) } }),
        framesFor: (clientId, action) => (toClient.get(clientId) ?? []).filter((f) => !action || f.action === action),
        last: (clientId, action) => {
            const list = (toClient.get(clientId) ?? []).filter((f) => f.action === action);
            return list[list.length - 1];
        },
    };
    return r;
}

/** Register a connected client as `userId`. */
export function connectAs(r: FakeRouter, clientId: string, userId: string | null, displayName?: string): void {
    if (userId) r.users.set(clientId, userId);
    if (displayName) r.names.set(clientId, displayName);
}
