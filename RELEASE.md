# Releasing `@connorhoehn/realtime-modules`

Manual release recipe. Keep it boring.

## Pre-release checklist

- [ ] All tests pass: `npm test`
- [ ] Typecheck clean: `npm run typecheck`
- [ ] `CHANGELOG.md` `[Unreleased]` section is up to date and accurate
- [ ] Version in `package.json` matches the tag you intend to cut
- [ ] No uncommitted work in `src/` or `test/`

## Recipe

1. **Clean dist** — `rm -rf dist`
2. **Build** — `npm run build` (must succeed; emits `dist/`)
3. **Test** — `NODE_OPTIONS='--max-old-space-size=2048' npx jest --no-coverage --maxWorkers=1`
4. **Bump version** — edit `package.json` `version` field; move CHANGELOG `[Unreleased]` content under a new `## [x.y.z] — YYYY-MM-DD` section
5. **Commit** — `git add package.json CHANGELOG.md && git commit -m "release(realtime-modules): vX.Y.Z"`
6. **Tag + push** — `git tag realtime-modules-vX.Y.Z && git push && git push --tags`

## `dist/` is gitignored — why this matters

`dist/` is **not committed**. Consumers materialize it two ways:

- **`file:` pins** (sibling repos): npm runs the `prepare` script on
  install, which builds `dist/` locally. Works without operator action.
- **`git tag` / `github:owner/repo#tag` pins**: npm clones the tag and
  expects `dist/` to be present. If you tagged without building, the
  install still runs `prepare` — but any tooling that reads `dist/`
  before install (e.g. CI cache warmers, IDE type resolvers) breaks.
- **npm publish** (future): `prepublishOnly` enforces build + test
  before the tarball is uploaded. `dist/` is included via the `files`
  allowlist in `package.json`.

## Historical lesson — v0.2.0 gotcha

The `realtime-modules-v0.2.0` tag was cut **without** running
`npm run build`. `dist/client/useAgentStream.{js,d.ts}` was missing
from the tag. `file:` consumers (gateway) were saved by the `prepare`
hook on install; OrgIQ adoption (commit `05f38c1` on aws-agentcore)
had to manually rebuild before the install resolved. Don't skip the
build step. The `prepublishOnly` script + this recipe exist to make
that mistake harder.
