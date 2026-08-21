#!/usr/bin/env node
// One command, whole demo: realtime server (:4001) + vite (:5173, proxying
// /realtime through so the client needs no configuration at all).
import { spawn } from 'node:child_process';
const procs = [
    spawn('node', ['server.mjs'], { stdio: 'inherit' }),
    spawn('npx', ['vite'], { stdio: 'inherit' }),
];
const stop = () => { for (const p of procs) p.kill('SIGINT'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) stop(); });
