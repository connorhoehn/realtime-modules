#!/usr/bin/env node
// Packed-consumer check: `npm pack` the package, install the tarball into a
// scratch project under a DIFFERENT dependency key (`rtm`, the way
// aws-agentcore installs it as `@connorhoehnslalom/realtime-modules`), and
// resolve and load every `exports` subpath from there. Catches what
// verify-exports cannot: files missing from the tarball (`files` allowlist),
// an export that only resolves in the source tree, and code that imports
// itself by its own package name.
// Needs a built dist/ and network access for distributed-core (a git dep).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'rtm-packed-'));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const errors = [];
try {
    const packOut = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], root);
    const tgz = join(work, JSON.parse(packOut)[0].filename);
    const consumer = join(work, 'consumer');
    run('mkdir', ['-p', consumer], work);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, version: '0.0.0', dependencies: { rtm: `file:${tgz}` } }));
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'], consumer);

    const installed = join(consumer, 'node_modules', 'rtm');
    const ipkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    if (ipkg.name !== pkg.name) errors.push(`installed name ${ipkg.name} != ${pkg.name} (installed under key "rtm")`);

    const probe = `
const pkg = JSON.parse(require('fs').readFileSync('node_modules/rtm/package.json','utf8'));
const out = [];
for (const sub of Object.keys(pkg.exports)) {
  if (sub === './package.json') continue;
  const spec = sub === '.' ? 'rtm' : 'rtm/' + sub.slice(2);
  try { require(spec); }
  catch (e) {
    const m = String(e && e.message || e);
    // A missing optional peer (react, tiptap, aws-sdk ...) is fine; a missing
    // file inside the package or an unresolvable subpath is not.
    const peerMiss = e && e.code === 'MODULE_NOT_FOUND' && /Cannot find module '([^'./][^']*)'/.exec(m) && !/^rtm\\b/.test(/Cannot find module '([^']*)'/.exec(m)[1]);
    if (!peerMiss) out.push(spec + ': ' + m.split('\\n')[0]);
  }
}
console.log(JSON.stringify(out));`;
    const res = JSON.parse(run('node', ['-e', probe], consumer).trim().split('\n').pop());
    errors.push(...res);
    for (const [sub, t] of Object.entries(pkg.exports)) {
        const types = typeof t === 'object' && t.types;
        if (types && !existsSync(join(installed, types))) errors.push(`exports['${sub}'].types ${types} missing from the tarball`);
    }
} catch (e) {
    errors.push(String(e.stderr || e.message || e));
} finally {
    rmSync(work, { recursive: true, force: true });
}
if (errors.length) {
    console.error('verify-packed-consumer FAILED:\n  ' + errors.join('\n  '));
    process.exit(1);
}
console.log('verify-packed-consumer ok');
