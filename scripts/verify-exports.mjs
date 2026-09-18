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

// 4. Hook coverage. Same lesson one level down: `./client` is documented as a
// subpath, but the hooks inside it are the actual API, and eleven of
// twenty-five had no row in the Hook reference — usePins, useChatMembers and
// useChatReadReceipts among them, all shipped within the fortnight before
// this check existed.
//
// Presence only. That a row EXISTS is checkable here; that it describes the
// right return shape is not, and the table was wrong about useCRDT
// (`{ doc, awareness }` for a hook that returns `{ content, applyLocalEdit,
// … }`) for long enough to prove a name check is not a correctness check.
const hookTable = readme.split('\n## Hook reference\n')[1]?.split('\n## ')[0] ?? '';
if (!hookTable) {
    errors.push('README has no `## Hook reference` section to check hooks against');
} else {
    const documentedHooks = new Set([...hookTable.matchAll(/^\|\s*`(use[A-Za-z]+)/gm)].map((m) => m[1]));
    const clientDts = await readFile(new URL('../dist/client/index.d.ts', import.meta.url), 'utf8');
    const exportedHooks = new Set([...clientDts.matchAll(/\b(use[A-Z][A-Za-z]+)\b/g)].map((m) => m[1]));
    for (const hook of [...exportedHooks].sort()) {
        if (!documentedHooks.has(hook)) {
            errors.push(`${hook} is exported from ./client but has no row in README's Hook reference`);
        }
    }
}

// 5. The same coverage for the hooks that live OUTSIDE ./client.
//
// Check 4 only ever looked at ./client, and eight hooks behind the media
// subpaths drifted in unmentioned because of it — useLVSContext,
// useLiveCaptions, useVoiceCapture, useMediaEffects among them. A subpath
// having its own barrel is not a reason for its API to be undiscoverable.
//
// Anywhere in README or docs/ counts here, unlike check 4: these are
// described in prose and recipes rather than in the ./client hook table, and
// forcing them into that table would blur the boundary the subpaths exist to
// draw.
const HOOK_SUBPATHS = [
    './client/video',
    './client/voice',
    './client/media-effects',
    './client/hangout-rooms',
    './client/pipelines',
];
const prose = [
    readme,
    ...(await Promise.all(
        (function walk(dir) {
            const out = [];
            for (const entry of readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
                if (entry.isDirectory()) out.push(...walk(`${dir}/${entry.name}`));
                else if (entry.name.endsWith('.md')) out.push(`${dir}/${entry.name}`);
            }
            return out;
        })('docs').map((f) => readFile(new URL(`../${f}`, import.meta.url), 'utf8')),
    )),
].join('\n');

// Exact tokens, not substrings: `useLiveCaptionsXX` contains `useLiveCaptions`,
// so an includes() check calls a renamed hook documented. Check 3 had the same
// flaw and it was caught the same way — by renaming a row and watching the
// guard stay green.
const documentedInProse = new Set([...prose.matchAll(/\b(use[A-Z][A-Za-z]*)\b/g)].map((m) => m[1]));

for (const subpath of HOOK_SUBPATHS) {
    const target = pkg.exports?.[subpath];
    const types = typeof target === 'string' ? target : target?.types;
    if (!types) continue;
    let dts;
    try {
        dts = await readFile(new URL('../' + types.replace(/^\.\//, ''), import.meta.url), 'utf8');
    } catch {
        continue; // check 1 already reports a missing backing file
    }
    for (const hook of new Set([...dts.matchAll(/\b(use[A-Z][A-Za-z]+)\b/g)].map((m) => m[1]))) {
        if (!documentedInProse.has(hook)) {
            errors.push(`${hook} is exported from ${subpath} but is documented nowhere in README or docs/`);
        }
    }
}

if (errors.length) {
    console.error('verify-exports FAILED:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
}
console.log(`verify-exports passed: ${Object.keys(pkg.exports).length - 1} subpaths backed + documented, every hook documented, no orphaned dist dirs.`);
