// 0.146.0: rooms and documents ask the router's checkChannel for every action.
// 0.147.0 (lane: fail-closed): a router without one is refused — RoomService
// and MeetingService throw at construction, and CRDTService (whose channel
// check then refuses every action) says so once — unless the host passes
// insecureAllowAll (local development only).

import { RoomService } from '../../src/room/RoomService';
import CRDTService from '../../src/server/CRDTService';
import { MemoryMetadataStore, MemorySnapshotStore } from '../../src/server/stores/MemoryStore';

const logger = () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() });
const warned = (l: ReturnType<typeof logger>) => l.warn.mock.calls.filter((c: any[]) => /checkChannel/.test(String(c[0]))).length;

describe('a router with no checkChannel', () => {
    it('RoomService refuses to start', () => {
        expect(() => new RoomService({ messageRouter: { sendToClient: () => true } as any, logger: logger() }))
            .toThrow(/RoomService: a router with checkChannel is required/);
    });

    it('RoomService works under insecureAllowAll', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const sent: any[] = [];
            const svc = new RoomService({ messageRouter: { sendToClient: (_c: string, m: unknown) => { sent.push(m); return true; } } as any,
                logger: logger(), insecureAllowAll: true });
            await svc.handleAction('c1', 'subscribe', { slug: 's' });
            expect(sent.filter((f) => f.type === 'error')).toHaveLength(0);
            await svc.dispose();
        } finally { warn.mockRestore(); }
    });

    it('CRDTService warns once that every action will be refused; a router with checkChannel does not warn', () => {
        const mk = (router: any) => {
            const l = logger();
            const svc: any = new CRDTService({ messageRouter: router, logger: l, authz: () => true,
                metadataStore: new MemoryMetadataStore(), snapshotStore: new MemorySnapshotStore() });
            return { l, svc };
        };
        const base = { sendToChannel: jest.fn(), broadcastToAll: jest.fn(), onRemoteChannelMessage: jest.fn() };
        const without = mk(base);
        expect(warned(without.l)).toBe(1);
        expect(String(without.l.warn.mock.calls[0][0])).toMatch(/refused/);
        const withCheck = mk({ ...base, checkChannel: () => true });
        expect(warned(withCheck.l)).toBe(0);
        for (const s of [without.svc, withCheck.svc]) s.shutdown?.();
    });
});
