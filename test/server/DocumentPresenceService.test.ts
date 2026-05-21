// realtime-modules/test/server/DocumentPresenceService.test.ts
//
// Lifted from gateway test/crdt-document-presence-service.test.js.

import DocumentPresenceService = require('../../src/server/DocumentPresenceService');

class NoopLogger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

function makeService(clientData: Record<string, any> = {}) {
    const broadcasts: any[] = [];
    const router: any = {
        getClientData: jest.fn((clientId: string) => clientData[clientId] || null),
        broadcastToAll: jest.fn((msg: any) => broadcasts.push(msg)),
        sendToChannel: jest.fn(async () => {}),
        onRemoteChannelMessage: jest.fn(),
    };
    const svc = new DocumentPresenceService(router, new NoopLogger());
    return { svc, router, broadcasts };
}

describe('DocumentPresenceService — addClient', () => {
    test('ignores channels that do not start with doc:', () => {
        const { svc, broadcasts } = makeService();
        svc.addClient('c1', 'crdt:doc:1');
        expect(svc.hasClient('c1', 'crdt:doc:1')).toBe(false);
        expect(broadcasts.length).toBe(0);
    });

    test('adds client to forward and reverse indexes', () => {
        const { svc } = makeService();
        svc.addClient('c1', 'doc:1');
        expect(svc.hasClient('c1', 'doc:1')).toBe(true);
        expect(svc.clientDocChannels.get('c1')?.has('doc:1')).toBe(true);
    });

    test('extracts userId and displayName from userContext', () => {
        const { svc } = makeService({
            c1: { userContext: { userId: 'u-42', displayName: 'Alice' } },
        });
        svc.addClient('c1', 'doc:1');
        const userInfo = svc.documentPresenceMap.get('doc:1')!.get('c1')!;
        expect(userInfo.userId).toBe('u-42');
        expect(userInfo.displayName).toBe('Alice');
    });

    test('falls back to clientId slice when no user context', () => {
        const { svc } = makeService();
        svc.addClient('clientXYZ123', 'doc:1');
        const userInfo = svc.documentPresenceMap.get('doc:1')!.get('clientXYZ123')!;
        expect(userInfo.userId).toBe('clientXYZ123');
        expect(userInfo.displayName).toBe('clientXY');
    });

    test('triggers broadcastPresence after adding', () => {
        const { svc, broadcasts } = makeService();
        svc.addClient('c1', 'doc:1');
        expect(broadcasts.length).toBe(1);
        expect(broadcasts[0].type).toBe('documents:presence');
    });

    test('idle defaults to false on add', () => {
        const { svc } = makeService();
        svc.addClient('c1', 'doc:1');
        expect(svc.documentPresenceMap.get('doc:1')!.get('c1')!.idle).toBe(false);
    });
});

describe('DocumentPresenceService — removeClient', () => {
    test('removes client from forward and reverse indexes', () => {
        const { svc } = makeService();
        svc.addClient('c1', 'doc:1');
        svc.removeClient('c1', 'doc:1');
        expect(svc.hasClient('c1', 'doc:1')).toBe(false);
        expect(svc.clientDocChannels.has('c1')).toBe(false);
    });

    test('removes empty channel map from documentPresenceMap', () => {
        const { svc } = makeService();
        svc.addClient('c1', 'doc:1');
        svc.removeClient('c1', 'doc:1');
        expect(svc.documentPresenceMap.has('doc:1')).toBe(false);
    });

    test('channel with remaining clients is kept', () => {
        const { svc } = makeService();
        svc.addClient('c1', 'doc:1');
        svc.addClient('c2', 'doc:1');
        svc.removeClient('c1', 'doc:1');
        expect(svc.documentPresenceMap.has('doc:1')).toBe(true);
        expect(svc.hasClient('c2', 'doc:1')).toBe(true);
    });

    test('ignores non-doc: channels', () => {
        const { svc, broadcasts } = makeService();
        svc.removeClient('c1', 'other:channel');
        expect(broadcasts.length).toBe(0);
    });
});

describe('DocumentPresenceService — removeAllForClient', () => {
    test('removes client from all tracked channels', () => {
        const { svc } = makeService();
        svc.addClient('c1', 'doc:A');
        svc.addClient('c1', 'doc:B');
        svc.removeAllForClient('c1');
        expect(svc.hasClient('c1', 'doc:A')).toBe(false);
        expect(svc.hasClient('c1', 'doc:B')).toBe(false);
        expect(svc.clientDocChannels.has('c1')).toBe(false);
    });

    test('is a no-op when client is not tracked', () => {
        const { svc, broadcasts } = makeService();
        expect(() => svc.removeAllForClient('unknown')).not.toThrow();
        expect(broadcasts.length).toBe(0);
    });
});

describe('DocumentPresenceService — setIdle', () => {
    test('returns true and updates idle when value changes', () => {
        const { svc } = makeService();
        svc.addClient('c1', 'doc:1');
        expect(svc.setIdle('c1', 'doc:1', true)).toBe(true);
        expect(svc.documentPresenceMap.get('doc:1')!.get('c1')!.idle).toBe(true);
    });

    test('returns false when idle is already the same', () => {
        const { svc } = makeService();
        svc.addClient('c1', 'doc:1');
        svc.setIdle('c1', 'doc:1', true);
        expect(svc.setIdle('c1', 'doc:1', true)).toBe(false);
    });

    test('returns false when client is not in the channel', () => {
        const { svc } = makeService();
        expect(svc.setIdle('c-unknown', 'doc:1', true)).toBe(false);
    });
});

describe('DocumentPresenceService — broadcastPresence userId dedup', () => {
    test('deduplicates by userId: active entry wins over idle', () => {
        const { svc, broadcasts } = makeService({
            c1: { userContext: { userId: 'u-1', displayName: 'Alice' } },
            c2: { userContext: { userId: 'u-1', displayName: 'Alice (tab 2)' } },
        });
        svc.addClient('c1', 'doc:1');
        svc.addClient('c2', 'doc:1');
        svc.setIdle('c1', 'doc:1', true);
        broadcasts.length = 0;
        svc.broadcastPresence();
        const doc = broadcasts[0].documents.find((d: any) => d.documentId === 'doc:1');
        expect(doc.users.length).toBe(1);
        expect(doc.users[0].idle).toBe(false);
    });

    test('different userIds each appear in the users list', () => {
        const { svc, broadcasts } = makeService({
            c1: { userContext: { userId: 'u-1' } },
            c2: { userContext: { userId: 'u-2' } },
        });
        svc.addClient('c1', 'doc:1');
        svc.addClient('c2', 'doc:1');
        broadcasts.length = 0;
        svc.broadcastPresence();
        const doc = broadcasts[0].documents.find((d: any) => d.documentId === 'doc:1');
        expect(doc.users.length).toBe(2);
    });

    test('broadcast message shape includes type, documents, and timestamp', () => {
        const { svc, broadcasts } = makeService();
        svc.addClient('c1', 'doc:1');
        const msg = broadcasts[0];
        expect(msg.type).toBe('documents:presence');
        expect(Array.isArray(msg.documents)).toBe(true);
        expect(typeof msg.timestamp).toBe('string');
    });
});

describe('DocumentPresenceService — accessors', () => {
    test('channelCount reflects number of tracked doc channels', () => {
        const { svc } = makeService();
        expect(svc.channelCount).toBe(0);
        svc.addClient('c1', 'doc:A');
        expect(svc.channelCount).toBe(1);
        svc.addClient('c2', 'doc:B');
        expect(svc.channelCount).toBe(2);
        svc.removeClient('c1', 'doc:A');
        expect(svc.channelCount).toBe(1);
    });

    test('getPresence returns the live documentPresenceMap reference', () => {
        const { svc } = makeService();
        svc.addClient('c1', 'doc:1');
        const presence = svc.getPresence();
        expect(presence).toBe(svc.documentPresenceMap);
        expect(presence.get('doc:1')!.has('c1')).toBe(true);
    });
});

describe('DocumentPresenceService — defensive branches', () => {
    test('removeClient is a no-op when channel was never added (channelMap + reverse-index miss)', () => {
        const { svc } = makeService();
        expect(() => svc.removeClient('c-unknown', 'doc:never-added')).not.toThrow();
        expect(svc.documentPresenceMap.has('doc:never-added')).toBe(false);
        expect(svc.clientDocChannels.has('c-unknown')).toBe(false);
    });

    test('removeClient on one of multiple tracked channels keeps the other in the reverse index', () => {
        const { svc } = makeService();
        svc.addClient('c1', 'doc:A');
        svc.addClient('c1', 'doc:B');
        svc.removeClient('c1', 'doc:A');
        expect(svc.clientDocChannels.get('c1')?.has('doc:B')).toBe(true);
        expect(svc.clientDocChannels.get('c1')?.has('doc:A')).toBe(false);
    });

    test('removeAllForClient leaves channels populated when other clients remain', () => {
        const { svc } = makeService();
        svc.addClient('c1', 'doc:A');
        svc.addClient('c2', 'doc:A');
        svc.removeAllForClient('c1');
        expect(svc.documentPresenceMap.has('doc:A')).toBe(true);
        expect(svc.hasClient('c2', 'doc:A')).toBe(true);
        expect(svc.hasClient('c1', 'doc:A')).toBe(false);
    });

    test('broadcastPresence is a no-op when messageRouter is null', () => {
        const svc = new DocumentPresenceService(null as any, new NoopLogger());
        expect(() => svc.broadcastPresence()).not.toThrow();
    });

    test('removeAllForClient tolerates inconsistent state where a channel is missing from documentPresenceMap', () => {
        const { svc } = makeService();
        svc.addClient('c1', 'doc:A');
        svc.addClient('c1', 'doc:B');
        svc.documentPresenceMap.delete('doc:A');
        expect(() => svc.removeAllForClient('c1')).not.toThrow();
        expect(svc.documentPresenceMap.has('doc:B')).toBe(false);
        expect(svc.clientDocChannels.has('c1')).toBe(false);
    });
});
