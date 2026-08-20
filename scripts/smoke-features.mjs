#!/usr/bin/env node
// Headless smoke against the BUILT dist — the artifact consumers actually
// install. The jest matrix validates src through ts-jest; this validates
// what ships. A stale or partial dist/ (the failure class that made
// v0.42.0 of distributed-core inert, and this package source-less for ten
// minors) fails here in seconds.
import http from 'node:http';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const server = require('../dist/server/index.js');
const {
    attachRealtime, chat, presence, cursor, reactions, activity, social,
    calls, ingest, pipeline, typedDocuments, rooms, notifications, fileUploads,
    collabDocs,
} = server;

const FEATURES = [
    ['chat', chat], ['presence', presence], ['cursor', cursor],
    ['reactions', reactions], ['activity', activity], ['social', social],
    ['call', calls], ['ingest', ingest], ['pipeline-ws', pipeline],
    ['typed-documents', typedDocuments], ['room', rooms],
    ['notification', notifications], ['fileupload', fileUploads],
    ['crdt', collabDocs],
];

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const connect = (port) => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime`);
    ws.on('open', () => res(ws)); ws.on('error', rej);
});

let failures = 0;
for (const [name, make] of FEATURES) {
    const httpServer = http.createServer();
    try {
        const handle = attachRealtime(httpServer, { features: [make()], path: '/realtime' });
        const port = await listen(httpServer);
        const ws = await connect(port);
        if (handle.listClients().length !== 1) throw new Error('client not tracked');
        ws.close();
        await handle.dispose();
        console.log(`  OK   ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}: ${err && err.message}`);
    } finally {
        await new Promise((r) => httpServer.close(() => r()));
    }
}

// One full-depth round-trip: chat over the shipped dist.
{
    const httpServer = http.createServer();
    const handle = attachRealtime(httpServer, { features: [chat()], path: '/realtime' });
    const port = await listen(httpServer);
    const a = await connect(port);
    const joined = new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('no joined ack')), 2000);
        a.on('message', (raw) => {
            const f = JSON.parse(String(raw));
            if (f.action === 'joined') { clearTimeout(t); res(f); }
        });
    });
    a.send(JSON.stringify({ service: 'chat', action: 'join', channel: 'chat:smoke' }));
    await joined;
    a.close();
    await handle.dispose();
    await new Promise((r) => httpServer.close(() => r()));
    console.log('  OK   chat join round-trip (dist)');
}

if (failures) { console.error(`smoke-features FAILED (${failures})`); process.exit(1); }
console.log('smoke-features passed: 14 features attach + round-trip against built dist.');
