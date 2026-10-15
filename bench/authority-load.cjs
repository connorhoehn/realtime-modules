#!/usr/bin/env node
// In-process authority load harness (lane R6). Not shipped (outside `files`).
//
//   node bench/authority-load.cjs [--sockets 400] [--group 4] [--sends 5]
//        [--query-ms 3] [--query-cpu-us 250] [--presence 1] [--flood 0]
//        [--cache 0] [--batch 0] [--rate 0] [--json]
//
// Server (main thread): attachRealtime({ chat(), presence() }) on the built
// dist, with a host `authorize` modelled on the OrgIQ BFF: every channel
// decision reads the channel's membership (one counted "member query":
// `--query-cpu-us` of synchronous work plus `--query-ms` of I/O wait),
// shared per operation through `scope.share`, and a principal revalidation.
// Clients run in a worker thread so their parsing does not load the server's
// event loop. Groups of `--group` sockets share one DM-like channel; at the
// burst every socket sends `--sends` chat messages at once (plus one presence
// set each with --presence 1). Latency is send → receipt at each other member.
// --flood N: one extra socket sends N frames/s for the burst's duration.
'use strict';
const http = require('http');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { performance, monitorEventLoopDelay } = require('perf_hooks');

function arg(name, def) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? Number(process.argv[i + 1]) : def;
}
function pct(xs, p) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return +s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)].toFixed(1);
}

if (isMainThread) main().catch(e => { console.error(e); process.exit(1); });
else clientWorker();

async function main() {
    const cfg = {
        sockets: arg('sockets', 400), group: arg('group', 4), sends: arg('sends', 5),
        queryMs: arg('query-ms', 3), queryCpuUs: arg('query-cpu-us', 250), presence: arg('presence', 1),
        flood: arg('flood', 0), cache: arg('cache', 0), batch: arg('batch', 0), rate: arg('rate', 0),
    };
    const rm = require(path.resolve(process.env.RM_DIST || path.join(__dirname, '../dist'), 'server'));
    const members = new Map(); // channel -> Set<userId>
    for (let i = 0; i < cfg.sockets; i++) {
        const ch = `dm:${Math.floor(i / cfg.group)}`;
        if (!members.has(ch)) members.set(ch, new Set());
        members.get(ch).add(`u${i}`);
    }
    members.set('dm:flood', new Set(['flooder']));
    const counters = { memberQueries: 0, authorize: 0, revalidate: 0, batchCalls: 0 };
    const busy = (us) => { const end = performance.now() + us / 1000; while (performance.now() < end) { /* spin */ } };
    const query = async (channel) => {
        counters.memberQueries++;
        busy(cfg.queryCpuUs);
        await new Promise(r => setTimeout(r, cfg.queryMs));
        return members.get(channel) ?? new Set();
    };
    const base = (channel) => channel.replace(/^(presence|reactions|cursor):/, '');
    const authorize = async ({ channel, ctx, scope }) => {
        counters.authorize++;
        const ch = base(channel);
        const rows = scope && scope.active ? await scope.share(`members:${ch}`, () => query(ch)) : await query(ch);
        return !!ctx && rows.has(ctx.userId);
    };
    const authorizeBatch = async ({ channel, recipients, scope }) => {
        counters.batchCalls++;
        const ch = base(channel);
        const rows = scope && scope.active ? await scope.share(`members:${ch}`, () => query(ch)) : await query(ch);
        return recipients.map(r => !!r.ctx && rows.has(r.ctx.userId));
    };
    const principal = { revalidate: async (ctx) => { counters.revalidate++; return !!ctx.userId; } };

    const server = http.createServer();
    const opts = {
        features: [rm.chat(), rm.presence()],
        path: '/ws',
        auth: (req) => ({ userId: new URL(req.url, 'http://x').searchParams.get('u'), epoch: 1 }),
        authorize, principal, pingIntervalMs: 0,
    };
    if (cfg.cache) opts.authorityCache = { epoch: (ctx) => ctx.epoch, maxAgeMs: 30_000 };
    if (cfg.batch) opts.authorizeBatch = authorizeBatch;
    if (cfg.rate) opts.inboundRateLimit = { framesPerSecond: 50, burst: 100 };
    const handle = rm.attachRealtime(server, opts);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const eld = monitorEventLoopDelay({ resolution: 5 });
    const worker = new Worker(__filename, { workerData: { port, cfg } });
    const msg = (type) => new Promise(r => { const h = (m) => { if (m.type === type) { worker.off('message', h); r(m); } }; worker.on('message', h); });
    await msg('joined');
    const before = { ...counters };
    eld.enable();
    const cpu0 = process.cpuUsage(); const t0 = performance.now();
    worker.postMessage({ type: 'burst' });
    const res = await msg('done');
    const wall = performance.now() - t0; const cpu = process.cpuUsage(cpu0);
    eld.disable();
    const stats = typeof handle.stats === 'function' ? handle.stats() : null;
    const d = (k) => counters[k] - before[k];
    const out = {
        cfg, sends: res.sends, delivered: res.lat.length, expected: res.expected,
        memberQueriesPerSend: +(d('memberQueries') / res.sends).toFixed(2),
        authorizePerSend: +(d('authorize') / res.sends).toFixed(2),
        revalidatePerSend: +(d('revalidate') / res.sends).toFixed(2),
        batchCallsPerSend: +(d('batchCalls') / res.sends).toFixed(2),
        chatP50: pct(res.lat, 50), chatP95: pct(res.lat, 95), chatP99: pct(res.lat, 99),
        burstWallMs: +wall.toFixed(0), serverCpuMs: +((cpu.user + cpu.system) / 1000).toFixed(0),
        eventLoopP99Ms: +(eld.percentile(99) / 1e6).toFixed(1), eventLoopMaxMs: +(eld.max / 1e6).toFixed(1),
        floodSent: res.floodSent, rateLimitErrors: res.rateErrors,
        stats,
    };
    console.log(process.argv.includes('--json') ? JSON.stringify(out) : JSON.stringify(out, null, 1));
    await worker.terminate();
    await handle.dispose();
    server.close();
}

function clientWorker() {
    const WebSocket = require('ws');
    const { port, cfg } = workerData;
    const socks = [];
    const lat = [];
    let rateErrors = 0;
    const open = (u) => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?u=${u}`);
        ws.on('message', (raw) => {
            const s = raw.toString();
            if (s.includes('RATE_LIMITED')) rateErrors++;
            const m = /"text":"b\|(\d+(?:\.\d+)?)\|(u\d+)"/.exec(s) || /b\|(\d+(?:\.\d+)?)\|(u\d+)/.exec(s);
            if (m && m[2] !== u && s.includes('"action":"message"')) lat.push(performance.now() - Number(m[1]));
        });
        ws.on('open', () => resolve(ws)); ws.on('error', reject);
    });
    (async () => {
        for (let i = 0; i < cfg.sockets; i += 50) {
            const batch = [];
            for (let j = i; j < Math.min(cfg.sockets, i + 50); j++) batch.push(open(`u${j}`).then(ws => { socks[j] = ws; }));
            await Promise.all(batch);
        }
        let flooder = null;
        if (cfg.flood) flooder = await open('flooder');
        for (let i = 0; i < cfg.sockets; i++) {
            const channel = `dm:${Math.floor(i / cfg.group)}`;
            socks[i].send(JSON.stringify({ service: 'chat', action: 'join', channel }));
            if (cfg.presence) socks[i].send(JSON.stringify({ service: 'presence', action: 'subscribe', channel }));
        }
        await new Promise(r => setTimeout(r, 1500));
        parentPort.postMessage({ type: 'joined' });
        parentPort.once('message', async () => {
            const t0 = performance.now();
            let floodSent = 0; let floodTimer = null;
            if (flooder) {
                const perTick = Math.max(1, Math.round(cfg.flood / 100));
                floodTimer = setInterval(() => {
                    for (let k = 0; k < perTick; k++) { flooder.send(JSON.stringify({ service: 'presence', action: 'set', status: 'online', channels: ['dm:flood'] })); floodSent++; }
                }, 10);
            }
            for (let k = 0; k < cfg.sends; k++) {
                for (let i = 0; i < cfg.sockets; i++) {
                    const channel = `dm:${Math.floor(i / cfg.group)}`;
                    socks[i].send(JSON.stringify({ service: 'chat', action: 'send', channel, message: `b|${performance.now()}|u${i}` }));
                    if (cfg.presence && k === 0) socks[i].send(JSON.stringify({ service: 'presence', action: 'set', status: 'online', channels: [channel] }));
                }
            }
            const sends = cfg.sends * cfg.sockets;
            const expected = sends * (cfg.group - 1);
            const deadline = performance.now() + 60_000;
            while (lat.length < expected && performance.now() < deadline) await new Promise(r => setTimeout(r, 20));
            if (floodTimer) clearInterval(floodTimer);
            parentPort.postMessage({ type: 'done', lat, sends, expected, floodSent, rateErrors, ms: performance.now() - t0 });
        });
    })().catch(e => { console.error('worker', e); process.exit(1); });
}
