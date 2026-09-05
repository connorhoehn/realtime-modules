// Document presence identity is LATE-BINDING.
//
// A presence entry used to freeze whatever identity the connection had at
// subscribe time. A client that joined a document during the window where its
// socket existed but its user context had not been attached — a reconnect
// restoring a clientId, most commonly — stayed anonymous for the rest of the
// session. Downstream that reads as a phantom second editor: the card says
// "Hank Anderson is editing now" and shows two avatars, one of them a UUID
// rendered as "Someone".

import DocumentPresenceService from '../../src/server/DocumentPresenceService';

const CH = 'doc:d1';
const HANK = 'client-hank';
const HANK_TAB2 = 'client-hank-tab2';

function makeRouter(contexts: Record<string, unknown>) {
    return {
        getClientData: (clientId: string) =>
            contexts[clientId] ? { userContext: contexts[clientId] } : null,
        broadcastToAll: jest.fn(),
    } as any;
}

const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };

// What consumers actually receive: one row per PERSON.
function usersIn(svc: DocumentPresenceService, channel = CH) {
    return svc.getPresenceByUser().get(channel) ?? [];
}

// The raw connection map, for asserting that two tabs really are two entries.
function connectionsIn(svc: DocumentPresenceService, channel = CH) {
    return [...(svc.getPresence().get(channel)?.values() ?? [])];
}

describe('DocumentPresenceService — identity', () => {
    it('keys an identified client by its userId', () => {
        const svc = new DocumentPresenceService(
            makeRouter({ [HANK]: { userId: 'dev-hank', displayName: 'Hank Anderson' } }), logger);
        svc.addClient(HANK, CH);
        expect(usersIn(svc)).toEqual([
            expect.objectContaining({ userId: 'dev-hank', displayName: 'Hank Anderson' }),
        ]);
    });

    // The state that produced the phantom: two connections, one human, but
    // only one of them had a context when it subscribed.
    it('names a client whose context arrived after it subscribed', () => {
        const contexts: Record<string, unknown> = {
            [HANK]: { userId: 'dev-hank', displayName: 'Hank Anderson' },
        };
        const svc = new DocumentPresenceService(makeRouter(contexts), logger);
        svc.addClient(HANK, CH);
        svc.addClient(HANK_TAB2, CH);

        // Before: one person and one UUID standing in for a person.
        expect(usersIn(svc)).toHaveLength(2);
        expect(usersIn(svc).map((u) => u.userId)).toContain(HANK_TAB2);

        // The context lands, and the next awareness frame refreshes it.
        contexts[HANK_TAB2] = { userId: 'dev-hank', displayName: 'Hank Anderson' };
        expect(svc.refreshIdentity(HANK_TAB2, CH)).toBe(true);

        // One human, one row — getPresence dedups by userId once both
        // connections agree on who they belong to.
        expect(usersIn(svc)).toEqual([
            expect.objectContaining({ userId: 'dev-hank', displayName: 'Hank Anderson' }),
        ]);
    });

    it('leaves an already-named entry alone', () => {
        const svc = new DocumentPresenceService(
            makeRouter({ [HANK]: { userId: 'dev-hank', displayName: 'Hank Anderson' } }), logger);
        svc.addClient(HANK, CH);
        expect(svc.refreshIdentity(HANK, CH)).toBe(false);
    });

    // Re-reading an empty context must not overwrite a good entry with a UUID.
    it('does not downgrade a named entry when the context goes away', () => {
        const contexts: Record<string, unknown> = {
            [HANK]: { userId: 'dev-hank', displayName: 'Hank Anderson' },
        };
        const svc = new DocumentPresenceService(makeRouter(contexts), logger);
        svc.addClient(HANK, CH);
        delete contexts[HANK];
        svc.refreshIdentity(HANK, CH);
        expect(usersIn(svc)[0]!.userId).toBe('dev-hank');
    });

    // One person in two tabs is one person. This used to be true of the
    // pushed presence and false of the polled reply.
    it('reports one row per person, however many connections they have', () => {
        const ctx = { userId: 'dev-hank', displayName: 'Hank Anderson' };
        const svc = new DocumentPresenceService(
            makeRouter({ [HANK]: ctx, [HANK_TAB2]: ctx }), logger);
        svc.addClient(HANK, CH);
        svc.addClient(HANK_TAB2, CH);

        expect(connectionsIn(svc)).toHaveLength(2);
        expect(usersIn(svc)).toHaveLength(1);
    });

    // An idle tab must not hide the one the person is actually typing in.
    it('prefers the active connection when a person has both', () => {
        const ctx = { userId: 'dev-hank', displayName: 'Hank Anderson' };
        const svc = new DocumentPresenceService(
            makeRouter({ [HANK]: ctx, [HANK_TAB2]: ctx }), logger);
        svc.addClient(HANK, CH);
        svc.setIdle(HANK, CH, true);
        svc.addClient(HANK_TAB2, CH);

        expect(usersIn(svc)).toEqual([expect.objectContaining({ idle: false })]);
    });

    it('stays anonymous while there is still nothing to resolve', () => {
        const svc = new DocumentPresenceService(makeRouter({}), logger);
        svc.addClient(HANK, CH);
        expect(svc.refreshIdentity(HANK, CH)).toBe(false);
        expect(usersIn(svc)[0]!.userId).toBe(HANK);
    });

    it('ignores a client that is not in the channel', () => {
        const svc = new DocumentPresenceService(makeRouter({}), logger);
        expect(svc.refreshIdentity(HANK, CH)).toBe(false);
    });
});
