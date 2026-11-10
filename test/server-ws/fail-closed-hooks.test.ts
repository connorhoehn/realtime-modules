// 0.147.0 (lane: fail-closed) — every authorization hook is required. One
// test per hook: construction throws without it, the `insecureAllowAll`
// opt-out lets it start in development, and the opt-out is refused when
// NODE_ENV=production. Plus the behaviour behind the socket options
// (allowedOrigins, a token without exp), the shared channel check on a router
// without checkChannel, and chat's sender identity.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { createWsHandler } from '../../src/server-ws';
import type { WsHandlerOptions } from '../../src/server-ws/types';
import { routerPermits } from '../../src/server-ws/channelAccess';
import { attachRealtime, calls, notifications, LocalRealtimeRouter } from '../../src/server';
import { RedisRealtimeRouter } from '../../src/server/RedisRealtimeRouter';
import { CRDTService } from '../../src/server/CRDTService';
import { MemorySnapshotStore, MemoryMetadataStore, MemoryHotCache } from '../../src/server/stores/MemoryStore';
import { CallService } from '../../src/call/CallService';
import PresenceService = require('../../src/presence/PresenceService');
import { CursorService } from '../../src/cursor/CursorService';
import { ReactionService } from '../../src/reactions/ReactionService';
import { FileUploadService } from '../../src/fileupload/FileUploadService';
import { NotificationService } from '../../src/notification/NotificationService';
import { RoomService } from '../../src/room/RoomService';
import { MeetingService } from '../../src/meeting/MeetingService';
import { ChatService } from '../../src/chat/ChatService';

const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const allow = () => true;

/** A custom router with no channel check: it enforces nothing. */
const openRouter = (): any => ({ sendToClient: () => undefined, sendToChannel: () => undefined });
/** A custom router whose channel check enforces. */
const enforcingRouter = (): any => ({ ...openRouter(), checkChannel: () => true });

let warn: jest.SpyInstance;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { warn.mockRestore(); });

function inProduction<T>(fn: () => T): T {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { return fn(); } finally { process.env.NODE_ENV = before; }
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
function keep<T extends { shutdown?: () => unknown; dispose?: () => unknown }>(svc: T): T {
    cleanups.push(() => (svc.shutdown ? svc.shutdown() : svc.dispose?.()));
    return svc;
}

/**
 * One hook: `build(undefined)` has no hook and no opt-out; `build(true)` has
 * the opt-out; `build('hook')` passes the hook.
 */
const HOOKS: Array<{ name: string; message: RegExp; build: (mode?: true | 'hook') => unknown }> = [
    {
        name: 'LocalRealtimeRouter authorize',
        message: /LocalRealtimeRouter: an authorize hook is required/,
        build: mode => new LocalRealtimeRouter(mode === 'hook' ? { authorize: allow } : mode ? { insecureAllowAll: true } : {}),
    },
    {
        name: 'RedisRealtimeRouter authorize',
        message: /RedisRealtimeRouter: an authorize hook is required/,
        // Construction only: the hook check runs before Redis is touched.
        build: mode => {
            const base = { redis: {} as any, namespace: 'test', nodeId: 'n1' };
            return new RedisRealtimeRouter(mode === 'hook' ? { ...base, authorize: allow } : mode ? { ...base, insecureAllowAll: true } : base);
        },
    },
    {
        name: 'createWsHandler auth',
        message: /createWsHandler: an auth hook is required/,
        build: mode => {
            const handle = createWsHandler({
                server: http.createServer(), services: {}, pingIntervalMs: 0,
                ...(mode === 'hook' ? { auth: () => ({ userId: 'u1', exp: 4e9 }) } : mode ? { insecureAllowAll: true } : {}),
            });
            cleanups.push(() => handle.dispose());
            return handle;
        },
    },
    {
        name: 'attachRealtime authorize',
        message: /LocalRealtimeRouter: an authorize hook is required/,
        build: mode => {
            const handle = attachRealtime(http.createServer(), {
                features: [], pingIntervalMs: 0,
                ...(mode === 'hook' ? { authorize: allow, auth: () => ({ userId: 'u1', exp: 4e9 }) } : mode ? { insecureAllowAll: true } : { auth: () => ({ userId: 'u1' }) }),
            });
            cleanups.push(() => handle.dispose());
            return handle;
        },
    },
    {
        name: 'CallService config.authorize',
        message: /CallService: a config.authorize hook is required/,
        build: mode => keep(new CallService({
            messageRouter: enforcingRouter(), logger,
            ...(mode === 'hook' ? { config: { authorize: allow } } : mode ? { insecureAllowAll: true } : {}),
        })),
    },
    {
        name: 'calls() lobbyGuard or config.authorize',
        message: /calls\(\): a lobbyGuard or config.authorize hook is required/,
        build: mode => {
            const feature = calls(mode === 'hook' ? { lobbyGuard: allow } : {});
            return keep(feature.create({ router: enforcingRouter(), logger, ...(mode === true ? { insecureAllowAll: true } : {}) }) as any);
        },
    },
    {
        name: 'PresenceService authorizeChannel',
        message: /PresenceService: an authorizeChannel hook \(or a router with an authorize hook\) is required/,
        build: mode => keep(new PresenceService(openRouter(), logger,
            mode === 'hook' ? { authorizeChannel: allow } : mode ? { insecureAllowAll: true } : {})),
    },
    {
        name: 'CursorService authorizeChannel',
        message: /CursorService: an authorizeChannel hook/,
        build: mode => keep(new CursorService({ messageRouter: openRouter(), logger,
            config: mode === 'hook' ? { authorizeChannel: allow } : mode ? { insecureAllowAll: true } : {} })),
    },
    {
        name: 'ReactionService authorizeChannel',
        message: /ReactionService: an authorizeChannel hook/,
        build: mode => new ReactionService({ messageRouter: openRouter(), logger,
            config: mode === 'hook' ? { authorizeChannel: allow } : mode ? { insecureAllowAll: true } : {} }),
    },
    {
        name: 'FileUploadService authz',
        message: /FileUploadService: an authz hook/,
        build: mode => new FileUploadService({ messageRouter: openRouter(), logger,
            ...(mode === 'hook' ? { authz: allow } : mode ? { insecureAllowAll: true } : {}) }),
    },
    {
        name: 'NotificationService authorize',
        message: /NotificationService: an authorize hook is required/,
        build: mode => new NotificationService({ messageRouter: enforcingRouter(), logger, store: {} as any, admit: allow,
            ...(mode === 'hook' ? { authorize: allow } : mode ? { insecureAllowAll: true } : {}) }),
    },
    {
        name: 'NotificationService admit',
        message: /NotificationService: an admit hook is required/,
        build: mode => new NotificationService({ messageRouter: enforcingRouter(), logger, store: {} as any, authorize: allow,
            ...(mode === 'hook' ? { admit: allow } : mode ? { insecureAllowAll: true } : {}) }),
    },
    {
        name: 'notifications() authorize',
        message: /notifications\(\): an authorize hook is required/,
        build: mode => notifications({ store: {} as any, admit: allow, ...(mode === 'hook' ? { authorize: allow } : {}) })
            .create({ router: enforcingRouter(), logger, ...(mode === true ? { insecureAllowAll: true } : {}) }),
    },
    {
        name: 'RoomService router checkChannel',
        message: /RoomService: a router with checkChannel is required/,
        build: mode => keep(new RoomService({ messageRouter: mode === 'hook' ? enforcingRouter() : openRouter(), logger,
            ...(mode === true ? { insecureAllowAll: true } : {}) })),
    },
    {
        name: 'MeetingService router checkChannel',
        message: /MeetingService: a router with checkChannel is required/,
        build: mode => keep(new MeetingService({ router: mode === 'hook' ? enforcingRouter() : openRouter(),
            ...(mode === true ? { insecureAllowAll: true } : {}) })),
    },
    {
        name: 'CRDTService authz',
        message: /CRDTService: an authz hook is required/,
        build: mode => keep(new CRDTService({
            messageRouter: enforcingRouter(), logger,
            snapshotStore: new MemorySnapshotStore(), metadataStore: new MemoryMetadataStore(), hotCache: new MemoryHotCache(),
            ...(mode === 'hook' ? { authz: allow } : mode ? { insecureAllowAll: true } : {}),
        } as any)),
    },
];

describe.each(HOOKS)('$name', ({ build, message }) => {
    it('throws at construction without the hook', () => {
        expect(() => build()).toThrow(message);
    });

    it('starts with the hook', () => {
        expect(() => build('hook')).not.toThrow();
    });

    it('starts under insecureAllowAll outside production', () => {
        expect(() => build(true)).not.toThrow();
    });

    it('refuses insecureAllowAll when NODE_ENV=production', () => {
        expect(() => inProduction(() => build(true))).toThrow(/insecureAllowAll is refused when NODE_ENV=production/);
    });
});

describe('services that a router enforces for', () => {
    it.each([
        ['presence', () => keep(new PresenceService(enforcingRouter(), logger, {}))],
        ['cursor', () => keep(new CursorService({ messageRouter: enforcingRouter(), logger }))],
        ['reactions', () => new ReactionService({ messageRouter: enforcingRouter(), logger })],
        ['uploads', () => new FileUploadService({ messageRouter: enforcingRouter(), logger })],
    ])('%s starts without its own hook when the router checks channels', (_n, build) => {
        expect(build).not.toThrow();
    });

    it('a LocalRealtimeRouter built with authorize counts as enforcing', () => {
        expect(() => keep(new PresenceService(new LocalRealtimeRouter({ authorize: allow }) as any, logger, {}))).not.toThrow();
    });

    it('a LocalRealtimeRouter built under insecureAllowAll lets its services start without hooks', () => {
        const router = new LocalRealtimeRouter({ insecureAllowAll: true }) as any;
        expect(() => keep(new PresenceService(router, logger, {}))).not.toThrow();
        expect(() => keep(new CallService({ messageRouter: router, logger }))).not.toThrow();
    });
});

describe('the opt-out warning', () => {
    it('is logged once, loudly, the first time the opt-out is accepted', () => {
        const { _resetInsecureAllowAllWarning } = require('../../src/server-ws/insecureAllowAll');
        _resetInsecureAllowAllWarning();
        new LocalRealtimeRouter({ insecureAllowAll: true });
        new LocalRealtimeRouter({ insecureAllowAll: true });
        const lines = warn.mock.calls.filter(c => String(c[0]).includes('insecureAllowAll is on'));
        expect(lines).toHaveLength(1);
        expect(String(lines[0][0])).toMatch(/Local development only/);
    });
});

describe('a router without checkChannel', () => {
    it('is refused by the shared channel check', async () => {
        await expect(routerPermits(openRouter(), 'subscribe', 'c1', 'chat:general')).resolves.toBe(false);
    });

    it('is let through once a service accepted it under insecureAllowAll', async () => {
        const router = openRouter();
        keep(new RoomService({ messageRouter: router, logger, insecureAllowAll: true }));
        await expect(routerPermits(router, 'subscribe', 'c1', 'chat:general')).resolves.toBe(true);
    });
});

describe('chat sender identity', () => {
    function chatRig(identity: { userId: string; displayName?: string } | null) {
        const sent: any[] = [];
        const router: any = {
            ...enforcingRouter(),
            sendToClient: (_c: string, m: unknown) => { sent.push(m); },
            sendToLocalClient: (_c: string, m: unknown) => { sent.push(m); },
            sendToChannel: (_ch: string, m: unknown) => { sent.push(m); },
            subscribeToChannel: () => true,
            unsubscribeFromChannel: () => undefined,
            broadcastToAll: () => undefined,
            getClientData: () => (identity ? { userContext: identity } : null),
            getUserIdForClient: () => identity?.userId,
        };
        const stored: any[] = [];
        const chatStore = { putMessage: async (m: any) => { stored.push(m); }, listMessages: async () => [] };
        const svc = keep(new ChatService({ messageRouter: router, logger, chatStore } as any));
        return { svc, sent, stored };
    }

    it('refuses a send from a connection with no authenticated user, whatever the frame says', async () => {
        const { svc, sent, stored } = chatRig(null);
        await svc.handleAction('c1', 'join', { channel: 'general' });
        await svc.handleAction('c1', 'send', { channel: 'general', message: 'hi', metadata: { userId: 'mallory', displayName: 'Admin' } });
        expect(stored).toHaveLength(0);
        expect(sent.some(f => f?.error?.code === 'CHAT_UNAUTHENTICATED' || f?.code === 'CHAT_UNAUTHENTICATED')).toBe(true);
    });

    it('names the sender from the principal and drops the frame copies', async () => {
        const { svc, stored } = chatRig({ userId: 'alice', displayName: 'Alice' });
        await svc.handleAction('c1', 'join', { channel: 'general' });
        await svc.handleAction('c1', 'send', { channel: 'general', message: 'hi', metadata: { userId: 'mallory', displayName: 'Admin' } });
        expect(stored).toHaveLength(1);
        expect(stored[0].userId).toBe('alice');
        expect(stored[0].metadata.displayName).toBe('Alice');
        expect(stored[0].metadata.userId).toBeUndefined();
    });

    it('ignores trustFrameSender: true', () => {
        const svc = keep(new ChatService({ messageRouter: enforcingRouter(), logger, trustFrameSender: true } as any));
        expect(svc.trustFrameSender).toBe(false);
    });
});

describe('socket upgrade rules', () => {
    async function rig(opts: Partial<WsHandlerOptions>) {
        const server = http.createServer();
        const handle = createWsHandler({ server, services: {}, pingIntervalMs: 0, ...opts });
        await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()));
        const port = (server.address() as AddressInfo).port;
        cleanups.push(async () => { await handle.dispose(); await new Promise<void>(res => server.close(() => res())); });
        return (origin?: string) => new Promise<'open' | string>((res) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/`, origin ? { origin } : {});
            ws.on('message', () => { res('open'); ws.close(); });
            ws.on('unexpected-response', (_req, r) => res(String(r.statusCode)));
            ws.on('error', e => res(e.message));
        });
    }
    const auth = () => ({ userId: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 });

    it('refuses a browser origin when no allowedOrigins are given', async () => {
        const connect = await rig({ auth });
        expect(await connect('https://evil.example')).toBe('403');
        expect(await connect()).toBe('open');
    });

    it('admits a listed origin exactly and refuses others', async () => {
        const connect = await rig({ auth, allowedOrigins: ['https://app.example'] });
        expect(await connect('https://app.example')).toBe('open');
        expect(await connect('https://app.example.evil')).toBe('403');
    });

    it('asks a predicate with the request, and a throwing predicate refuses', async () => {
        const seen: string[] = [];
        const connect = await rig({ auth, allowedOrigins: (origin, req) => {
            seen.push(String(req.headers.host).split(':')[0]);
            if (origin === 'https://boom.example') throw new Error('boom');
            return origin === 'https://app.example';
        } });
        expect(await connect('https://app.example')).toBe('open');
        expect(await connect('https://other.example')).toBe('403');
        expect(await connect('https://boom.example')).toBe('403');
        expect(seen).toContain('127.0.0.1');
    });

    it('accepts any origin under insecureAllowAll without a list', async () => {
        const connect = await rig({ insecureAllowAll: true });
        expect(await connect('https://anything.example')).toBe('open');
    });

    it('treats a token without exp as expired', async () => {
        const connect = await rig({ auth: () => ({ userId: 'u1' }) });
        expect(await connect()).toBe('401');
    });
});
