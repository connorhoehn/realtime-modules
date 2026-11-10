#!/usr/bin/env node
// Browser-safety guard for every client-facing subpath.
//
// 0.147.0 shipped `./proxy-client` with a top-level
// require('@connorhoehn/service-runtime'), a Node-only package (it uses
// async_hooks AsyncLocalStorage). Browser apps import that subpath at boot, so
// a fresh Vite dependency cache rendered every consumer page blank with
// "AsyncLocalStorage is not a constructor". This script bundles each
// client-facing export from dist/ with esbuild `platform: 'browser'` and fails
// when the bundle reaches a Node builtin, the service-runtime package, or
// another server-only dependency.
//
// Run: `npm run verify:browser-safe` (dist; also part of verify:exports and
// build) or `node scripts/verify-browser-safe.mjs --src` (TypeScript sources).
//
// A `require()` whose specifier is not a string literal is invisible to
// bundlers on purpose; that is how the proxy client loads service-runtime
// only when a signing secret is configured (server-side callers).
//
// Server-only subpaths are listed in SERVER_ONLY with the reason. Adding a
// subpath to package.json `exports` without classifying it here fails the run,
// so a new entry cannot skip the check.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

// Subpaths a browser app may import. Every one must bundle cleanly.
export const CLIENT_ENTRIES = [
    './agent-streaming/client',
    './client',
    './client/ws',
    './client/video',
    './client/voice',
    './client/media-effects',
    './client/hangout-rooms',
    './client/meeting',
    './client/pipelines',
    './client/documents',
    './adapters/tiptap',
    './adapters/excalidraw',
    './proxy-client',
    './call',
    './room',
    './meeting',
    './hangout-rooms',
    './deck',
    './typed-documents',
    './work-graph',
];

// Subpaths that run only in Node, and why.
export const SERVER_ONLY = {
    '.': 'deprecated barrel that includes ./agent-streaming and ./server-ws',
    './proxy-client/server': 'imports @connorhoehn/service-runtime statically for request signing',
    './agent-streaming': 'gateway-side agent stream service',
    './server-ws': 'ws + express gateway host',
    './server': 'gateway server helpers',
    './server/stores/dynamo': 'DynamoDB stores (@aws-sdk)',
    './chat': 'gateway ChatService and stores',
    './presence': 'gateway PresenceService',
    './activity': 'gateway ActivityService',
    './cursor': 'gateway CursorService',
    './ingest': 'gateway ingest fan-out',
    './pipeline': 'gateway pipeline fan-out',
    './reactions': 'gateway ReactionService',
    './social': 'gateway social fan-out',
    './notification': 'gateway NotificationService (Redis store)',
    './fileupload': 'gateway FileUploadService and blob storage',
    './work-graph/server': 'work-graph server half',
    './testing': 'jest/Node test helpers',
};

// Bundled peers a browser app provides itself; left external, never flagged.
const BROWSER_PEERS = [/^react(-dom)?(\/|$)/, /^@tiptap\//, /^y-protocols(\/|$)/, /^yjs$/, /^lib0(\/|$)/, /^@excalidraw\//, /^pptxgenjs$/];

// Packages that cannot run in a browser.
const NODE_ONLY_PACKAGES = [
    /^@connorhoehn\/service-runtime(\/|$)/,
    /^ws$/,
    /^express(\/|$)/,
    /^@aws-sdk\//,
    /^redis(\/|$)/,
    /^ioredis(\/|$)/,
];
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

function isBuiltin(spec) {
    return spec.startsWith('node:') || BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0]);
}

// `--src` bundles the TypeScript sources behind each subpath instead of dist/
// (the jest test uses it, so a regression fails before anyone rebuilds).
const FROM_SRC = process.argv.includes('--src');

function targetOf(subpath) {
    const t = pkg.exports[subpath];
    const rel = typeof t === 'string' ? t : (t.browser ?? t.import ?? t.default ?? t.require);
    if (!FROM_SRC) return rel;
    const base = rel.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '');
    for (const ext of ['.ts', '.tsx']) {
        if (existsSync(path.join(root, base + ext))) return base + ext;
    }
    throw new Error(`no source file behind exports['${subpath}'] (${base}.ts)`);
}

const errors = [];
const exported = Object.keys(pkg.exports ?? {}).filter((s) => s !== './package.json');
for (const s of exported) {
    if (!CLIENT_ENTRIES.includes(s) && !(s in SERVER_ONLY)) {
        errors.push(`exports['${s}'] is not classified: add it to CLIENT_ENTRIES or SERVER_ONLY in scripts/verify-browser-safe.mjs`);
    }
}
for (const s of [...CLIENT_ENTRIES, ...Object.keys(SERVER_ONLY)]) {
    if (!exported.includes(s)) errors.push(`'${s}' is classified but not in package.json exports`);
}

async function check(subpath) {
    const hits = [];
    const guard = {
        name: 'browser-safe-guard',
        setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
                if (args.kind === 'entry-point') return undefined;
                const spec = args.path;
                if (spec.startsWith('.') || path.isAbsolute(spec)) return undefined;
                const from = path.relative(root, args.importer);
                if (isBuiltin(spec)) {
                    hits.push(`Node builtin '${spec}' imported by ${from}`);
                    return { path: spec, external: true };
                }
                if (NODE_ONLY_PACKAGES.some((re) => re.test(spec))) {
                    hits.push(`Node-only package '${spec}' imported by ${from}`);
                    return { path: spec, external: true };
                }
                if (BROWSER_PEERS.some((re) => re.test(spec))) return { path: spec, external: true };
                return undefined;
            });
            // dist/ is CommonJS, so a consumer's bundler resolves this
            // package's dependencies with the `require` condition. Resolve the
            // TypeScript sources' imports the same way in --src mode.
            if (FROM_SRC) {
                build.onResolve({ filter: /^[^./]/ }, async (args) => {
                    if (args.pluginData?.asRequire || !args.importer.startsWith(path.join(root, 'src'))) return undefined;
                    const r = await build.resolve(args.path, {
                        kind: 'require-call',
                        resolveDir: args.resolveDir,
                        importer: args.importer,
                        pluginData: { asRequire: true },
                    });
                    return r.errors.length ? undefined : { path: r.path, external: r.external, sideEffects: r.sideEffects };
                });
            }
        },
    };
    const result = await esbuild.build({
        entryPoints: [path.join(root, targetOf(subpath))],
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'esm',
        logLevel: 'silent',
        plugins: [guard],
    }).catch((e) => ({ errors: e.errors ?? [{ text: String(e) }] }));
    for (const e of result.errors ?? []) {
        hits.push(`esbuild: ${e.text}${e.location ? ` (${e.location.file}:${e.location.line})` : ''}`);
    }
    return hits;
}

for (const subpath of CLIENT_ENTRIES) {
    if (!exported.includes(subpath)) continue;
    const hits = await check(subpath);
    if (hits.length === 0) {
        console.log(`ok   ${subpath}`);
    } else {
        console.log(`FAIL ${subpath}`);
        for (const h of [...new Set(hits)]) errors.push(`${subpath}: ${h}`);
    }
}

if (errors.length) {
    console.error(`\nverify-browser-safe: ${errors.length} problem(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
}
console.log(`verify-browser-safe (${FROM_SRC ? 'src' : 'dist'}): ${CLIENT_ENTRIES.length} client-facing subpaths bundle for the browser without Node-only imports`);
