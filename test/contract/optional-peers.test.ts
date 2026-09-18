// test/contract/optional-peers.test.ts
//
// An optional peer must not be needed to IMPORT a subpath.
//
// `peerDependenciesMeta` marks a peer optional so npm neither installs nor
// warns about it. If a barrel then `require`s that peer at module scope, a
// consumer who took the declaration at its word gets a hard
// MODULE_NOT_FOUND — not on the feature they skipped, but on the import line
// of the entry point itself.
//
// That is what `./client` did. useCanvasDocument imported `@tiptap/y-tiptap`
// at the top, and pmModel reached `@tiptap/core` through MacroNode just to
// read the string 'macro' — so `import { useChat } from '.../client'` threw
// for anyone without Tiptap installed, while the barrel's own header promised
// that consumers on Monaco or CodeMirror "don't pull in Tiptap or ProseMirror".
//
// These tests walk the BUILT graph, because that is what a consumer resolves.
// Run `npm run build` if dist is stale.

import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import Module from 'module';

const ROOT = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Every external module id reachable by require() from an entry file. */
function externalDeps(entry: string): Set<string> {
  const seen = new Set<string>();
  const ext = new Set<string>();
  (function walk(file: string) {
    let resolved: string;
    try {
      resolved = require.resolve(file);
    } catch {
      return;
    }
    if (seen.has(resolved)) return;
    seen.add(resolved);
    let src: string;
    try {
      src = fs.readFileSync(resolved, 'utf8');
    } catch {
      return;
    }
    for (const m of src.matchAll(/require\("([^"]+)"\)/g)) {
      const req = m[1]!;
      if (req.startsWith('.')) walk(path.join(path.dirname(resolved), req));
      else ext.add(req);
    }
  })(entry);
  return ext;
}

const optionalPeers = Object.entries(pkg.peerDependenciesMeta ?? {})
  .filter(([, v]) => (v as { optional?: boolean }).optional)
  .map(([k]) => k);

describe('optional peers are not needed to import a subpath', () => {
  it('./client pulls no @tiptap package', () => {
    const deps = [...externalDeps(path.join(ROOT, 'dist/client/index.js'))];
    expect(deps.filter((d) => d.startsWith('@tiptap/'))).toEqual([]);
  });

  // The proof a consumer cares about: the barrel loads with Tiptap absent.
  it('./client imports with every @tiptap resolution failing', () => {
    const orig = (Module as unknown as { _resolveFilename: (...a: unknown[]) => string })._resolveFilename;
    (Module as unknown as { _resolveFilename: unknown })._resolveFilename = function (
      this: unknown,
      req: string,
      ...rest: unknown[]
    ) {
      if (/^@tiptap\//.test(req)) {
        const err = new Error(`Cannot find module '${req}'`) as Error & { code?: string };
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return orig.call(this, req, ...rest);
    };
    try {
      for (const k of Object.keys(require.cache)) {
        if (k.includes(`${path.sep}dist${path.sep}`)) delete require.cache[k];
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const client = require(path.join(ROOT, 'dist/client/index.js'));
      expect(typeof client.useChat).toBe('function');
      expect(typeof client.useCanvasDocument).toBe('function');
    } finally {
      (Module as unknown as { _resolveFilename: unknown })._resolveFilename = orig;
      for (const k of Object.keys(require.cache)) {
        if (k.includes(`${path.sep}dist${path.sep}`)) delete require.cache[k];
      }
    }
  });

  // `_subpaths` is the contract: it says which entry points a peer belongs to.
  // A subpath may eagerly require a peer that lists it — ./client requires
  // y-protocols because it IS the CRDT surface, and ./client/ws exists as the
  // Yjs-free one. What it may not do is require a peer that does not claim it,
  // which is the state ./client was in for every @tiptap package.
  it.each([
    ['./client', 'dist/client/index.js'],
    ['./client/ws', 'dist/client/ws.js'],
    ['./agent-streaming/client', 'dist/agent-streaming/client.js'],
    ['./proxy-client', 'dist/proxy-client/index.js'],
    ['./server-ws', 'dist/server-ws/index.js'],
    ['./chat', 'dist/chat/index.js'],
    ['./presence', 'dist/presence/index.js'],
    ['./cursor', 'dist/cursor/index.js'],
  ])('%s requires no optional peer that disclaims it', (subpath, rel) => {
    const deps = externalDeps(path.join(ROOT, rel));
    const offenders = optionalPeers.filter((peer) => {
      const used = [...deps].some((d) => d === peer || d.startsWith(`${peer}/`));
      if (!used) return false;
      const declared: string[] =
        (pkg.peerDependenciesMeta?.[peer] as { _subpaths?: string[] })?._subpaths ?? [];
      return !declared.includes(subpath as string);
    });
    expect(offenders).toEqual([]);
  });

  it('the _subpaths note for each @tiptap peer no longer claims ./client', () => {
    for (const [name, meta] of Object.entries(pkg.peerDependenciesMeta ?? {})) {
      if (!name.startsWith('@tiptap/')) continue;
      const subpaths = (meta as { _subpaths?: string[] })._subpaths ?? [];
      expect(subpaths).not.toContain('./client');
    }
  });
});
