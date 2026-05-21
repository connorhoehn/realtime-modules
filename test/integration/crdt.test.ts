// realtime-modules/test/integration/crdt.test.ts
//
// Integration tests for the CRDT document-sync protocol over WebSocket.
//
// Strategy: spin up a real http.Server + ws.WebSocketServer with CRDTService
// wired in-process (MemorySnapshotStore + MemoryMetadataStore + MemoryHotCache,
// no DDB-local / Redis-local needed).  Use the connectTestClient helper from
// the harness so test-frame handling (waitForMessage, disconnect) is consistent
// with the rest of the integration suite.
//
// The CRDTService is NOT yet in the FEATURE_REGISTRY inside factory.ts, so we
// wire it manually here — the same pattern that harness.ts uses for chat /
// presence.
//
// WS protocol primer (from CRDTService.handleAction):
//
//   Client → server frames:
//     { service:'crdt', action:'subscribe',   channel }
//     { service:'crdt', action:'update',      channel, update: <base64> }
//     { service:'crdt', action:'unsubscribe', channel }
//     { service:'crdt', action:'getSnapshot', channel }
//
//   Server → client frames (sent by CRDTService.sendToClient):
//     { type:'crdt', action:'subscribed',    channel, timestamp }
//     { type:'crdt:snapshot',               channel, snapshot: <base64> }   (on subscribe if doc non-empty)
//     { type:'crdt:update',                 channel, update: <base64> }     (broadcast after batching)
//     { type:'crdt', action:'unsubscribed', channel, timestamp }
//     { type:'error', service:'crdt', ... }

import * as http from 'http';
import * as Y from 'yjs';
import WebSocket from 'ws';

import { createWsHandler } from '../../src/server-ws/createWsHandler';
import type { WsHandlerHandle } from '../../src/server-ws/types';
import CRDTService from '../../src/server/CRDTService';
import {
    MemorySnapshotStore,
    MemoryMetadataStore,
    MemoryHotCache,
} from '../../src/server/stores/MemoryStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CrdtTestServer {
    url: string;
    crdtSvc: CRDTService;
    snapshotStore: MemorySnapshotStore;
    stop(): Promise<void>;
}

interface TestClient {
    ws: WebSocket;
    send(msg: object): void;
    waitForMessage(predicate: (m: object) => boolean, timeoutMs?: number): Promise<object>;
    disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Noop logger
// ---------------------------------------------------------------------------

const noopLogger = {
    debug(): void { /* noop */ },
    info(): void { /* noop */ },
    warn(): void { /* noop */ },
    error(): void { /* noop */ },
};

// ---------------------------------------------------------------------------
// In-process CRDT message router
//
// Wires CRDTService to the WsHandlerHandle so sendToClient + sendToChannel
// work, and supports subscribeToChannel / unsubscribeFromChannel for the
// subscriber fan-out that CRDTService's operationCoalescer drives.
// ---------------------------------------------------------------------------

class CrdtInProcessRouter {
    private handle: WsHandlerHandle | null = null;

    /** channel → Set<clientId> */
    private readonly channelMembers = new Map<string, Set<string>>();

    readonly nodeId = 'crdt-test-node';
    readonly redisAvailable = false;

    setHandle(h: WsHandlerHandle): void {
        this.handle = h;
    }

    sendToClient(clientId: string, message: unknown): void {
        this.handle?.sendToClient(clientId, message as Record<string, unknown>);
    }

    async sendToChannel(channel: string, message: unknown, excludeClientId?: string): Promise<void> {
        const members = this.channelMembers.get(channel);
        if (!members) return;
        for (const clientId of members) {
            if (clientId === excludeClientId) continue;
            this.sendToClient(clientId, message);
        }
    }

    async broadcastToAll(message: unknown): Promise<void> {
        if (!this.handle) return;
        for (const clientId of this.handle.listClients()) {
            this.sendToClient(clientId, message);
        }
    }

    onRemoteChannelMessage(_type: string, _handler: (payload: unknown) => void): void {
        // Single-node test: no cross-node updates to route.
    }

    subscribeToChannel(clientId: string, channel: string): void {
        if (!this.channelMembers.has(channel)) this.channelMembers.set(channel, new Set());
        this.channelMembers.get(channel)!.add(clientId);
    }

    unsubscribeFromChannel(clientId: string, channel: string): void {
        this.channelMembers.get(channel)?.delete(clientId);
    }

    getClientData(_clientId: string): null {
        return null;
    }
}

// ---------------------------------------------------------------------------
// startCrdtTestServer
// ---------------------------------------------------------------------------

async function startCrdtTestServer(): Promise<CrdtTestServer> {
    const httpServer = http.createServer();
    await new Promise<void>((resolve, reject) => {
        httpServer.on('error', reject);
        httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind');
    const port = (addr as any).port as number;

    const snapshotStore = new MemorySnapshotStore();
    const metadataStore = new MemoryMetadataStore();
    const hotCache = new MemoryHotCache();

    const router = new CrdtInProcessRouter();

    const crdtSvc = new CRDTService({
        messageRouter: router as any,
        snapshotStore,
        metadataStore,
        hotCache,
        logger: noopLogger,
    });

    const handle = createWsHandler({
        server: httpServer,
        services: { crdt: crdtSvc as any },
        pingIntervalMs: 0,
    });

    router.setHandle(handle);

    return {
        url: `ws://127.0.0.1:${port}`,
        crdtSvc,
        snapshotStore,
        async stop(): Promise<void> {
            try { await crdtSvc.shutdown(); } catch { /* swallow */ }
            await handle.dispose();
            if (typeof (httpServer as any).closeAllConnections === 'function') {
                try { (httpServer as any).closeAllConnections(); } catch { /* swallow */ }
            }
            await new Promise<void>((resolve) => {
                const t = setTimeout(() => resolve(), 500);
                httpServer.close(() => { clearTimeout(t); resolve(); });
            });
        },
    };
}

// ---------------------------------------------------------------------------
// connectCrdtClient — thin TestClient wrapper
// ---------------------------------------------------------------------------

async function connectCrdtClient(serverUrl: string): Promise<TestClient> {
    const ws = new WebSocket(serverUrl);
    const buffer: object[] = [];
    const waiters: Array<{
        predicate: (m: object) => boolean;
        resolve: (m: object) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }> = [];

    ws.on('message', (raw) => {
        let parsed: object;
        try { parsed = JSON.parse(raw.toString()); }
        catch { parsed = { __raw: raw.toString() }; }

        const idx = waiters.findIndex((w) => w.predicate(parsed));
        if (idx !== -1) {
            const w = waiters.splice(idx, 1)[0];
            clearTimeout(w.timer);
            w.resolve(parsed);
        } else {
            buffer.push(parsed);
        }
    });

    await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.once('unexpected-response', (_req, res) =>
            reject(new Error(`WS upgrade rejected: HTTP ${res.statusCode}`)));
    });

    return {
        ws,
        send(msg: object): void { ws.send(JSON.stringify(msg)); },
        waitForMessage(predicate, timeoutMs = 5_000): Promise<object> {
            const bi = buffer.findIndex((m) => predicate(m));
            if (bi !== -1) return Promise.resolve(buffer.splice(bi, 1)[0]);
            return new Promise<object>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const i = waiters.findIndex((w) => w.resolve === resolve);
                    if (i !== -1) waiters.splice(i, 1);
                    reject(new Error(`waitForMessage timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                waiters.push({ predicate, resolve, reject, timer });
            });
        },
        disconnect(): Promise<void> {
            return new Promise<void>((resolve) => {
                if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
                ws.once('close', () => resolve());
                ws.close();
            });
        },
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a Y.Map text write as a base64 Y.js update string. */
function makeYjsUpdate(key: string, value: string): string {
    const doc = new Y.Doc();
    const map = doc.getMap('content');
    map.set(key, value);
    const update = Y.encodeStateAsUpdate(doc);
    return Buffer.from(update).toString('base64');
}

/** Decode a base64 Y.js update and read the 'content' map. */
function decodeContentMap(base64: string): Record<string, unknown> {
    const doc = new Y.Doc();
    const update = new Uint8Array(Buffer.from(base64, 'base64'));
    Y.applyUpdate(doc, update);
    const map = doc.getMap('content');
    const result: Record<string, unknown> = {};
    for (const [k, v] of map.entries()) {
        result[k] = v;
    }
    return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CRDT integration — document sync over WebSocket', () => {
    // All four tests share a single server to reduce start/stop overhead.
    let server: CrdtTestServer;

    beforeAll(async () => {
        server = await startCrdtTestServer();
    });

    afterAll(async () => {
        await server.stop();
    });

    // -----------------------------------------------------------------------
    // 1. Initial state: subscribe → receive subscribed ack
    // -----------------------------------------------------------------------

    it('client receives subscribed ack when joining a document channel', async () => {
        const client = await connectCrdtClient(server.url);
        try {
            // Consume session handshake.
            await client.waitForMessage((m) => (m as any).type === 'session');

            client.send({ service: 'crdt', action: 'subscribe', channel: 'doc:empty-1' });

            const ack = await client.waitForMessage(
                (m) => (m as any).type === 'crdt' && (m as any).action === 'subscribed',
            );
            expect((ack as any).channel).toBe('doc:empty-1');
            expect(typeof (ack as any).timestamp).toBe('string');
        } finally {
            await client.disconnect();
        }
    });

    // -----------------------------------------------------------------------
    // 2. Update propagation: client A writes → client B receives crdt:update
    // -----------------------------------------------------------------------

    it('update from client A propagates to client B on the same channel', async () => {
        const channel = 'doc:propagation-1';
        const [clientA, clientB] = await Promise.all([
            connectCrdtClient(server.url),
            connectCrdtClient(server.url),
        ]);

        try {
            // Consume session frames.
            await clientA.waitForMessage((m) => (m as any).type === 'session');
            await clientB.waitForMessage((m) => (m as any).type === 'session');

            // Both subscribe.
            clientA.send({ service: 'crdt', action: 'subscribe', channel });
            clientB.send({ service: 'crdt', action: 'subscribe', channel });

            await clientA.waitForMessage(
                (m) => (m as any).type === 'crdt' && (m as any).action === 'subscribed',
            );
            await clientB.waitForMessage(
                (m) => (m as any).type === 'crdt' && (m as any).action === 'subscribed',
            );

            // Client A sends a Y.js update containing { hello: 'world' }.
            const updateBase64 = makeYjsUpdate('hello', 'world');
            clientA.send({ service: 'crdt', action: 'update', channel, update: updateBase64 });

            // Client B should receive a crdt:update broadcast.
            const broadcastFrame = await clientB.waitForMessage(
                (m) => (m as any).type === 'crdt:update' && (m as any).channel === channel,
                8_000, // extra time for the UpdateCoalescer window
            );

            expect((broadcastFrame as any).type).toBe('crdt:update');
            expect(typeof (broadcastFrame as any).update).toBe('string');

            // Decode the broadcast and verify the content made it through.
            const content = decodeContentMap((broadcastFrame as any).update);
            expect(content['hello']).toBe('world');
        } finally {
            await Promise.all([clientA.disconnect(), clientB.disconnect()]);
        }
    });

    // -----------------------------------------------------------------------
    // 3. Snapshot persistence: after update, SnapshotStore contains doc state
    // -----------------------------------------------------------------------

    it('snapshot store contains document state after an update is applied', async () => {
        const channel = 'doc:snapshot-persist-1';
        const client = await connectCrdtClient(server.url);

        try {
            await client.waitForMessage((m) => (m as any).type === 'session');

            client.send({ service: 'crdt', action: 'subscribe', channel });
            await client.waitForMessage(
                (m) => (m as any).type === 'crdt' && (m as any).action === 'subscribed',
            );

            // Write a Y.js update.
            const updateBase64 = makeYjsUpdate('key', 'snapshot-value');
            client.send({ service: 'crdt', action: 'update', channel, update: updateBase64 });

            // Wait for the coalescer to broadcast (confirms the update was applied).
            await client.waitForMessage(
                (m) => (m as any).type === 'crdt:update' && (m as any).channel === channel,
                8_000,
            );

            // Trigger an explicit snapshot flush by unsubscribing — CRDTService
            // writes a snapshot when subscriberCount drops to 0 AND there are
            // pending operations (operationsSinceSnapshot > 0).
            client.send({ service: 'crdt', action: 'unsubscribe', channel });
            await client.waitForMessage(
                (m) => (m as any).type === 'crdt' && (m as any).action === 'unsubscribed',
            );

            // Give the async snapshot write a moment to complete.
            await new Promise((r) => setTimeout(r, 200));

            // SnapshotStore must have a snapshot for this channel.
            const stored = await server.snapshotStore.getLatestSnapshot(channel);
            expect(stored).not.toBeNull();
            expect(stored!.bytes.byteLength).toBeGreaterThan(0);
        } finally {
            await client.disconnect();
        }
    });

    // -----------------------------------------------------------------------
    // 4. Late joiner: client C joins after A and B have edited → receives merged state
    // -----------------------------------------------------------------------

    it('late joiner receives a snapshot that includes edits made by earlier clients', async () => {
        const channel = 'doc:late-joiner-1';
        const [clientA, clientB] = await Promise.all([
            connectCrdtClient(server.url),
            connectCrdtClient(server.url),
        ]);

        try {
            await clientA.waitForMessage((m) => (m as any).type === 'session');
            await clientB.waitForMessage((m) => (m as any).type === 'session');

            // A and B subscribe.
            clientA.send({ service: 'crdt', action: 'subscribe', channel });
            clientB.send({ service: 'crdt', action: 'subscribe', channel });
            await clientA.waitForMessage(
                (m) => (m as any).type === 'crdt' && (m as any).action === 'subscribed',
            );
            await clientB.waitForMessage(
                (m) => (m as any).type === 'crdt' && (m as any).action === 'subscribed',
            );

            // A writes a key, B writes a different key.
            clientA.send({
                service: 'crdt', action: 'update', channel,
                update: makeYjsUpdate('fromA', 'alpha'),
            });
            clientB.send({
                service: 'crdt', action: 'update', channel,
                update: makeYjsUpdate('fromB', 'beta'),
            });

            // Wait for both updates to propagate (each receives the other's update).
            await clientA.waitForMessage(
                (m) => (m as any).type === 'crdt:update' && (m as any).channel === channel,
                8_000,
            );
            await clientB.waitForMessage(
                (m) => (m as any).type === 'crdt:update' && (m as any).channel === channel,
                8_000,
            );
        } finally {
            await Promise.all([clientA.disconnect(), clientB.disconnect()]);
        }

        // Short delay so disconnect handling runs.
        await new Promise((r) => setTimeout(r, 100));

        // Client C joins late.
        const clientC = await connectCrdtClient(server.url);
        try {
            await clientC.waitForMessage((m) => (m as any).type === 'session');

            clientC.send({ service: 'crdt', action: 'subscribe', channel });

            // CRDTService sends subscribed ack then, if the Y.Doc has content,
            // a crdt:snapshot frame.
            await clientC.waitForMessage(
                (m) => (m as any).type === 'crdt' && (m as any).action === 'subscribed',
            );

            const snapshotFrame = await clientC.waitForMessage(
                (m) => (m as any).type === 'crdt:snapshot' && (m as any).channel === channel,
                5_000,
            );

            // Decode the snapshot and verify both clients' edits are present.
            const content = decodeContentMap((snapshotFrame as any).snapshot);
            expect(content['fromA']).toBe('alpha');
            expect(content['fromB']).toBe('beta');
        } finally {
            await clientC.disconnect();
        }
    });
});
