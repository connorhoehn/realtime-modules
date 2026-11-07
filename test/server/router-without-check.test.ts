// 0.146.0: rooms and documents ask the router's checkChannel for every action.
// A router without one is trusted (not refused), and each service says so once.

import { RoomService } from '../../src/room/RoomService';
import CRDTService from '../../src/server/CRDTService';
import { MemoryMetadataStore, MemorySnapshotStore } from '../../src/server/stores/MemoryStore';

const logger = () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() });
const warned = (l: ReturnType<typeof logger>) => l.warn.mock.calls.filter((c: any[]) => /checkChannel/.test(String(c[0]))).length;

describe('a router with no checkChannel', () => {
    it('RoomService warns once and still works', async () => {
        const l = logger();
        const sent: any[] = [];
        const svc = new RoomService({ messageRouter: { sendToClient: (_c: string, m: unknown) => { sent.push(m); return true; } } as any, logger: l });
        await svc.handleAction('c1', 'subscribe', { slug: 's' });
        await svc.handleAction('c1', 'subscribe', { slug: 't' });
        expect(warned(l)).toBe(1);
        expect(sent.filter((f) => f.type === 'error')).toHaveLength(0);
        await svc.dispose();
    });

    it('CRDTService warns once; a router with checkChannel does not warn', () => {
        const mk = (router: any) => {
            const l = logger();
            const svc: any = new CRDTService({ messageRouter: router, logger: l, authz: () => true,
                metadataStore: new MemoryMetadataStore(), snapshotStore: new MemorySnapshotStore() });
            return { l, svc };
        };
        const base = { sendToChannel: jest.fn(), broadcastToAll: jest.fn(), onRemoteChannelMessage: jest.fn() };
        const without = mk(base);
        expect(warned(without.l)).toBe(1);
        const withCheck = mk({ ...base, checkChannel: () => true });
        expect(warned(withCheck.l)).toBe(0);
        for (const s of [without.svc, withCheck.svc]) s.shutdown?.();
    });
});
