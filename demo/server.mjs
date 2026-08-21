#!/usr/bin/env node
// Demo realtime server — the recipes, executed.
//
// This is the entire backend for the showcase app: one http server, one
// attachRealtime call, eight capabilities. No gateway deployment, no Redis,
// no env vars. Identity comes from the `?user=` query param (the provider
// appends it), so presence names and upload attribution work out of the box.
//
// Graduating any capability to production is a per-feature affair — see
// docs/recipes/ — and multi-node means swapping the router, not the features.
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
    attachRealtime,
    chat, presence, cursor, reactions, activity,
    rooms, notifications, fileUploads, collabDocs,
} = require('@connorhoehn/realtime-modules/server');

const PORT = Number(process.env.DEMO_REALTIME_PORT || 4001);

const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, features: realtime ? Object.keys(realtime.services) : [] }));
        return;
    }
    res.writeHead(404); res.end();
});

const realtime = attachRealtime(httpServer, {
    path: '/realtime',
    features: [
        chat(), presence(), cursor(), reactions(), activity(),
        rooms(), notifications(), fileUploads(), collabDocs(),
    ],
    auth: (req) => {
        const url = new URL(req.url ?? '/', 'http://demo');
        const userId = url.searchParams.get('user') || `demo-${Math.random().toString(36).slice(2, 8)}`;
        return { userId, displayName: userId };
    },
    logger: console,
});

httpServer.listen(PORT, () => {
    console.log(`[demo] realtime server on :${PORT} — features: ${Object.keys(realtime.services).join(', ')}`);
});
