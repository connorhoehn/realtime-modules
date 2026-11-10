// 0.146.0 (package 8) — the hooks fail closed: one test per module showing
// that a socket in tenant A receives zero frames carrying tenant B's data
// while tenant B uses that module, with a same-tenant positive control so the
// silence is not just a broken feature.
//
// Tenant A is `acme` (acme.alice, acme.amy); tenant B is `zebra` (zebra.bob,
// zebra.bea, zebra.zed). Every tenant-B identifier contains "zebra", so a leak
// is any frame tenant A receives whose JSON mentions it. The host's only
// tenant rule is the router `authorize` below — the same shape a real host
// writes — and the modules must route everything through it.

import http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { attachRealtime, baseChannel, calls, chat, collabDocs, rooms, type RealtimeHandle } from '../../src/server';
import { MemoryMetadataStore } from '../../src/server/stores/MemoryStore';

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function eventually(predicate: () => boolean, ms = 3000) {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (predicate()) return; await delay(10); }
    throw new Error('condition did not become true');
}

const leaks = (frames: any[]) => frames.filter(f => JSON.stringify(f).toLowerCase().includes('zebra'));

interface Client { ws: WebSocket; frames: any[]; send(frame: Record<string, unknown>): void; since(mark: number): any[] }

async function rig(features: Parameters<typeof attachRealtime>[1]['features'], metadataStore?: MemoryMetadataStore) {
    const docTenant = new Map<string, string>();
    const tenantOf = async (base: string): Promise<string | null> => {
        if (base.startsWith('doc:')) {
            const id = base.slice(4);
            if (docTenant.has(id)) return docTenant.get(id)!;
            const rec = metadataStore ? await metadataStore.getDocument(id) : null;
            const owner = rec?.ownerId ? rec.ownerId.split('.')[0] : id.split('-')[0];
            docTenant.set(id, owner);
            return owner;
        }
        if (base.startsWith('room:')) return base.slice(5).split(':')[0];
        if (base.startsWith('chat:')) return base.slice(5).split(':')[0];
        if (base.startsWith('call-lobby:')) return base.slice(11).split(':')[0];
        return base.split(':')[0];
    };
    const server = http.createServer();
    const handle: RealtimeHandle = attachRealtime(server, {
        features,
        path: '/realtime',
        pingIntervalMs: 0,
        auth: (req) => {
            const q = new URL(req.url ?? '/', 'http://x').searchParams;
            const user = q.get('user')!;
            return { userId: user, tenant: user.split('.')[0], displayName: user, exp: Math.floor(Date.now() / 1000) + 3600 };
        },
        authorize: async ({ channel, ctx }) => !!ctx && (await tenantOf(baseChannel(channel))) === ctx.tenant,
    });
    await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()));
    const port = (server.address() as AddressInfo).port;
    const sockets: WebSocket[] = [];
    const connect = (user: string) => new Promise<Client>((res, rej) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?user=${encodeURIComponent(user)}`);
        sockets.push(ws);
        const frames: any[] = [];
        const client: Client = {
            ws, frames,
            send: (frame) => ws.send(JSON.stringify(frame)),
            since: (mark) => frames.slice(mark),
        };
        ws.on('message', raw => { const f = JSON.parse(raw.toString()); frames.push(f); if (f.type === 'session') res(client); });
        ws.on('error', rej);
    });
    const stop = async () => {
        for (const ws of sockets) ws.close();
        await handle.dispose();
        await new Promise<void>(res => server.close(() => res()));
    };
    return { handle, connect, stop };
}

function yUpdate(text: string): string {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, text);
    const out = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
    doc.destroy();
    return out;
}

describe('documents (crdt)', () => {
    it('refuses to start without an authz hook', () => {
        const server = http.createServer();
        expect(() => attachRealtime(server, { features: [collabDocs()], path: '/realtime', authorize: () => true, auth: () => ({ userId: 'u', exp: 4e9 }) })).toThrow(/authz/);
    });

    it('tenant A receives nothing while tenant B edits, creates and renames documents', async () => {
        const metadataStore = new MemoryMetadataStore();
        const r = await rig([collabDocs({ metadataStore, authz: () => true })], metadataStore);
        try {
            const alice = await r.connect('acme.alice');
            const bob = await r.connect('zebra.bob');
            const bea = await r.connect('zebra.bea');
            alice.send({ service: 'crdt', action: 'subscribe', channel: 'doc:acme-doc' });
            bea.send({ service: 'crdt', action: 'subscribe', channel: 'doc:zebra-doc' });
            await eventually(() => alice.frames.some(f => f.action === 'subscribed') && bea.frames.some(f => f.action === 'subscribed'));
            await delay(100);
            const mark = alice.frames.length;

            bob.send({ service: 'crdt', action: 'subscribe', channel: 'doc:zebra-doc' });
            bob.send({ service: 'crdt', action: 'update', channel: 'doc:zebra-doc', update: yUpdate('zebra secret') });
            bob.send({ service: 'crdt', action: 'createDocument', meta: { title: 'zebra plans' } });
            const created = await (async () => {
                await eventually(() => bob.frames.some(f => f.action === 'documentCreated'));
                return bob.frames.find(f => f.action === 'documentCreated').document;
            })();
            bob.send({ service: 'crdt', action: 'updateDocumentMeta', documentId: created.id, meta: { title: 'zebra plans v2' } });
            // Bob reaching for tenant A's document is refused, and says nothing to A.
            bob.send({ service: 'crdt', action: 'subscribe', channel: 'doc:acme-doc' });
            bob.send({ service: 'crdt', action: 'update', channel: 'doc:acme-doc', update: yUpdate('zebra was here') });

            // Positive control: bea, in tenant B, hears all of it.
            await eventually(() => bea.frames.some(f => f.action === 'documentCreated' && f.document?.id === created.id));
            await eventually(() => bea.frames.some(f => f.action === 'documentMetaUpdated'));
            await delay(300);
            expect(leaks(alice.since(mark))).toEqual([]);
        } finally { await r.stop(); }
    });

    it('refuses a frame whose documentId and channel name different documents', async () => {
        const metadataStore = new MemoryMetadataStore();
        const r = await rig([collabDocs({ metadataStore, authz: () => true })], metadataStore);
        try {
            const bob = await r.connect('zebra.bob');
            // Authorised against zebra-doc, it used to list doc:acme-doc's snapshots.
            bob.send({ service: 'crdt', action: 'listSnapshots', documentId: 'zebra-doc', channel: 'doc:acme-doc' });
            await eventually(() => bob.frames.some(f => f.type === 'error' || f.action === 'snapshotList'));
            expect(bob.frames.some(f => f.action === 'snapshotList')).toBe(false);
            // The same action with the two agreeing still works.
            bob.send({ service: 'crdt', action: 'listSnapshots', documentId: 'zebra-doc', channel: 'doc:zebra-doc' });
            await eventually(() => bob.frames.some(f => f.action === 'snapshotList'));
            expect(bob.frames.find(f => f.action === 'snapshotList').channel).toBe('doc:zebra-doc');
        } finally { await r.stop(); }
    });
});

describe('calls', () => {
    it('tenant A receives nothing while tenant B rings, signals and hangs up', async () => {
        const r = await rig([calls({ lobbyGuard: (auth, lobby) => lobby.startsWith(`${String(auth.tenant)}:`) })]);
        try {
            const alice = await r.connect('acme.alice');
            const bob = await r.connect('zebra.bob');
            const bea = await r.connect('zebra.bea');
            const zed = await r.connect('zebra.zed');
            await delay(50);
            const mark = alice.frames.length;
            const zedMark = zed.frames.length;
            const lobby = 'zebra:dm:zebra.bea:zebra.bob';

            bob.send({ service: 'call', action: 'invite', callId: 'zebra-call', lobbyName: lobby, callerId: 'zebra.bob', targetUserIds: ['zebra.bea'] });
            await eventually(() => bea.frames.some(f => f.type === 'call' && f.action === 'invite'));
            bea.send({ service: 'call', action: 'accepted', callId: 'zebra-call', lobbyName: lobby, callerId: 'zebra.bob', targetUserIds: ['zebra.bob'] });
            await eventually(() => bob.frames.some(f => f.type === 'call' && f.action === 'accepted'));
            // Untargeted: before 0.146.0 this went to every socket in every tenant.
            bob.send({ service: 'call', action: 'participant-state', callId: 'zebra-call', lobbyName: lobby, status: 'joined', muted: true });
            await eventually(() => bea.frames.some(f => f.type === 'call' && f.action === 'participant-state'));
            // Someone not in the call cannot signal into it.
            zed.send({ service: 'call', action: 'participant-state', callId: 'zebra-call', lobbyName: lobby, status: 'joined', note: 'zed' });
            zed.send({ service: 'call', action: 'ended', callId: 'zebra-call', lobbyName: lobby, targetUserIds: ['zebra.bea'] });
            // An untargeted invite is refused by default.
            bob.send({ service: 'call', action: 'invite', callId: 'zebra-huddle', lobbyName: 'zebra:huddle', callerId: 'zebra.bob' });
            await eventually(() => bob.frames.some(f => f.type === 'error' && (f.code === 'untargeted-invite' || f.error?.code === 'untargeted-invite')));
            // Status of a DM lobby the asker is not in is refused.
            zed.send({ service: 'call', action: 'status', lobbyName: lobby });
            await delay(300);

            expect(leaks(alice.since(mark))).toEqual([]);
            const zedSaw = zed.since(zedMark).filter(f => f.type === 'call');
            expect(zedSaw).toEqual([]);
            expect(bea.frames.some(f => f.type === 'call' && f.data?.note === 'zed')).toBe(false);
            expect(bea.frames.some(f => f.type === 'call' && f.action === 'ended')).toBe(false);
        } finally { await r.stop(); }
    });
});

describe('rooms', () => {
    it('tenant A receives nothing while tenant B joins and announces rooms; identity comes from the socket', async () => {
        const r = await rig([rooms({ config: { occupancyDebounceMs: 20 } })]);
        try {
            const alice = await r.connect('acme.alice');
            const bob = await r.connect('zebra.bob');
            const bea = await r.connect('zebra.bea');
            alice.send({ service: 'room', action: 'subscribe-index' });
            alice.send({ service: 'room', action: 'subscribe', slug: 'zebra:lounge' });
            bea.send({ service: 'room', action: 'subscribe-index' });
            bea.send({ service: 'room', action: 'subscribe', slug: 'zebra:lounge' });
            await delay(100);
            const mark = alice.frames.length;

            // The frame claims to be acme.alice; the room must record zebra.bob.
            bob.send({ service: 'room', action: 'join', slug: 'zebra:lounge', userId: 'acme.alice', displayName: 'Alice' });
            bob.send({ service: 'room', action: 'announce', slug: 'zebra:lounge', event: 'created', room: { name: 'zebra lounge' } });
            // Bob reaching into tenant A's room is refused.
            bob.send({ service: 'room', action: 'join', slug: 'acme:lobby' });

            await eventually(() => bea.frames.some(f => f.type === 'room' && f.action === 'member-joined'));
            const joined = bea.frames.find(f => f.type === 'room' && f.action === 'member-joined');
            expect(joined.data.userId).toBe('zebra.bob');
            await eventually(() => bea.frames.some(f => f.type === 'room' && f.action === 'created'));
            await eventually(() => bea.frames.some(f => f.type === 'room' && f.action === 'occupancy-delta'
                && f.data.deltas.some((d: any) => d.slug === 'zebra:lounge' && d.count === 1)));
            await delay(200);
            expect(leaks(alice.since(mark))).toEqual([]);
            // acme:lobby was never joined, so no index anywhere shows it.
            expect(bea.frames.some(f => JSON.stringify(f).includes('acme:lobby'))).toBe(false);
        } finally { await r.stop(); }
    });
});

describe('chat direct messages', () => {
    it('tenant A receives nothing from a tenant-B DM, and a non-member of the DM is refused', async () => {
        const r = await rig([chat()]);
        try {
            const alice = await r.connect('acme.alice');
            const bob = await r.connect('zebra.bob');
            const bea = await r.connect('zebra.bea');
            const zed = await r.connect('zebra.zed');
            const dm = 'chat:zebra:dm:zebra.bea:zebra.bob';
            bob.send({ service: 'chat', action: 'join', channel: dm });
            bea.send({ service: 'chat', action: 'join', channel: dm });
            await eventually(() => bob.frames.some(f => f.action === 'joined') && bea.frames.some(f => f.action === 'joined'));
            const mark = alice.frames.length;

            alice.send({ service: 'chat', action: 'join', channel: dm });
            zed.send({ service: 'chat', action: 'join', channel: dm });
            await eventually(() => zed.frames.some(f => f.type === 'error'));
            const zedMark = zed.frames.length;
            bob.send({ service: 'chat', action: 'send', channel: dm, message: 'zebra secret' });
            await eventually(() => bea.frames.some(f => f.type === 'chat' && f.message?.message === 'zebra secret'));
            await delay(200);

            expect(leaks(alice.since(mark)).filter(f => f.type !== 'error')).toEqual([]);
            expect(zed.frames.some(f => f.type === 'error' && f.error?.code === 'CHAT_DM_FORBIDDEN')).toBe(true);
            expect(zed.since(zedMark).some(f => f.type === 'chat')).toBe(false);
        } finally { await r.stop(); }
    });

    it('a hashed group DM fails closed without a member resolver', async () => {
        const r = await rig([chat()]);
        try {
            const bob = await r.connect('zebra.bob');
            bob.send({ service: 'chat', action: 'join', channel: 'chat:zebra:dmg:0123456789abcdef01234567' });
            await eventually(() => bob.frames.some(f => f.type === 'error' || f.action === 'joined'));
            expect(bob.frames.some(f => f.action === 'joined')).toBe(false);
            expect(bob.frames.some(f => f.error?.code === 'CHAT_DM_FORBIDDEN')).toBe(true);
        } finally { await r.stop(); }
    });
});
