#!/usr/bin/env node
// Verify the published surface is real, both directions:
//   1. every package.json `exports` subpath has a backing dist file, and
//   2. every dist/ directory has a corresponding src/ directory — build
//      output may not outlive its source (the v0.6–v0.16 lesson: eleven
//      subpaths shipped for ten minor versions with no source anywhere).
//   3. every subpath is named in README's Subpaths section — the sibling
//      lesson: twelve subpaths, `./client/pipelines` and its whole
//      usePipelineRunStatus surface among them, shipped and tested while the
//      README's migration table told consumers they were "gateway-internal;
//      no library entry point". A surface nobody can find is unpublished in
//      every way that matters to a consumer.
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

// 3. Documentation coverage. Scoped to README's `## Subpaths` section so a
// passing mention elsewhere (a changelog line, a code sample) does not count
// as documenting the surface — the table is where a consumer goes looking.
//
// The subpath must OWN a table row, not merely appear in one. Rows
// cross-reference each other (the `./pipeline` row names `./client/pipelines`
// as its client half), and a mention in someone else's row is exactly the
// state this check exists to catch.
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const subpathsSection = readme.split('\n## Subpaths\n')[1]?.split('\n## ')[0] ?? '';
if (!subpathsSection) {
    errors.push('README has no `## Subpaths` section to check exports against');
} else {
    const documented = new Set(
        subpathsSection
            .split('\n')
            .map((line) => /^\|\s*`([^`]+)`\s*\|/.exec(line)?.[1])
            .filter(Boolean),
    );
    for (const subpath of Object.keys(pkg.exports ?? {})) {
        if (subpath === './package.json') continue;
        if (!documented.has(subpath)) {
            errors.push(`exports['${subpath}'] has no row in README's Subpaths section`);
        }
    }
}

if (errors.length) {
    console.error('verify-exports FAILED:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
}
console.log(`verify-exports passed: ${Object.keys(pkg.exports).length - 1} subpaths backed + documented, no orphaned dist dirs.`);
