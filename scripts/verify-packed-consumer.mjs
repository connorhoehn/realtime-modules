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
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, version: '0.0.0', dependencies: { rtm: `file:${tgz}`, ws: '^8.0.0', 'y-protocols': '^1.0.0' } }));
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'], consumer);

    const installed = join(consumer, 'node_modules', 'rtm');
    const ipkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    if (ipkg.name !== pkg.name) errors.push(`installed name ${ipkg.name} != ${pkg.name} (installed under key "rtm")`);

    // Required runtime dependencies may not be mistaken for optional peers.
    const serverProbe = `
const assert = require('node:assert/strict');
const http = require('node:http');
const { attachRealtime, planRealtimeComposition, RealtimeStartupError } = require('rtm/server');
const feature = { manifest: { name: 'durable', version: '1', adapterRequirements: [{ provider: 'store', capabilities: ['conditional-write'] }] }, create: () => ({ handleAction() {} }) };
assert.throws(() => planRealtimeComposition([feature]), /missing-provider/);
const handle = attachRealtime(http.createServer(), { features: [feature], capabilityProviders: [{ id: 'store', capabilities: ['conditional-write'] }] });
handle.dispose().catch(error => { console.error(error); process.exitCode = 1; });
assert.equal(typeof RealtimeStartupError, 'function');`;
    run(process.execPath, ['-e', serverProbe], consumer);

    // Run the pure entry point in a browser-like VM without Node globals or
    // external requires. Every transitive import must stay inside the package.
    const browserProbe = `
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const entry = require.resolve('rtm/hangout-rooms');
const dist = path.resolve('node_modules/rtm/dist') + path.sep;
const context = vm.createContext({ URL, URLSearchParams, fetch, Response, AbortController });
const cache = new Map();
function load(file) {
  assert.ok(file.startsWith(dist), 'browser import escaped package: ' + file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const localRequire = spec => {
    assert.ok(spec.startsWith('.'), 'browser import loaded an external module: ' + spec);
    return load(require.resolve(path.resolve(path.dirname(file), spec)));
  };
  const factory = vm.runInContext('(function(require, module, exports) {' + fs.readFileSync(file, 'utf8') + String.fromCharCode(10) + '})', context);
  factory(localRequire, module, module.exports);
  return module.exports;
}
const api = load(entry);
assert.equal(api.parseHangoutPlanInput({ expectedVersion: 0, mode: 'assigned', allowReturnToMain: true, rooms: [] }).expectedVersion, 0);
assert.equal(typeof api.updateRoom, 'function');
assert.ok([...cache.keys()].every(file => !file.includes('/server/') && !file.includes('/use')));`;
    run(process.execPath, ['-e', browserProbe], consumer);
    writeFileSync(join(consumer, 'esm.mjs'), `import { parseHangoutPlanInput } from 'rtm/hangout-rooms';
if (parseHangoutPlanInput({ expectedVersion: 0, mode: 'assigned', allowReturnToMain: true, rooms: [] }).expectedVersion !== 0) throw Error('ESM contract');
`);
    run(process.execPath, ['esm.mjs'], consumer);
    writeFileSync(join(consumer, 'contract.ts'), `import { parseHangoutPlanInput, type HangoutPlanInput, type Room, type UpdateRoomInput } from 'rtm/hangout-rooms';
const plan: HangoutPlanInput = parseHangoutPlanInput({});
const patch: UpdateRoomInput = { plan };
const read = (room: Room): number | undefined => room.plan?.version;
void patch; void read;
`);
    for (const resolution of ['node', 'nodenext']) {
        run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'es2022', '--module', resolution === 'node' ? 'commonjs' : 'nodenext', '--moduleResolution', resolution, 'contract.ts'], consumer);
    }

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
    const res = JSON.parse(run(process.execPath, ['-e', probe], consumer).trim().split('\n').pop());
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
