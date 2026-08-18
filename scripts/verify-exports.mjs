#!/usr/bin/env node
// Verify the published surface is real, both directions:
//   1. every package.json `exports` subpath has a backing dist file, and
//   2. every dist/ directory has a corresponding src/ directory — build
//      output may not outlive its source (the v0.6–v0.16 lesson: eleven
//      subpaths shipped for ten minor versions with no source anywhere).
// Runs as part of `npm run build`, NOT prepublishOnly — publish-time gates
// never fire for a package consumers install from a git ref.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const errors = [];

for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (subpath === './package.json') continue;
    const candidates = typeof target === 'string'
        ? [target]
        : [target.require, target.default, target.import, target.types].filter(Boolean);
    for (const rel of candidates) {
        if (!existsSync(new URL('../' + rel, import.meta.url))) {
            errors.push(`exports['${subpath}'] -> ${rel} has no backing file`);
        }
    }
}

const SRC_EXEMPT = new Set(['esm']); // no esm build here today; placeholder
for (const entry of readdirSync(new URL('../dist', import.meta.url))) {
    const distPath = new URL(`../dist/${entry}`, import.meta.url);
    if (!statSync(distPath).isDirectory() || SRC_EXEMPT.has(entry)) continue;
    if (!existsSync(new URL(`../src/${entry}`, import.meta.url))) {
        errors.push(`dist/${entry}/ has no src/${entry}/ — build output outliving source`);
    }
}

if (errors.length) {
    console.error('verify-exports FAILED:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
}
console.log(`verify-exports passed: ${Object.keys(pkg.exports).length - 1} subpaths backed, no orphaned dist dirs.`);
