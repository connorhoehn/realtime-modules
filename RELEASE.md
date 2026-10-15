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
5. **Commit** — include the changed source/tests, `package.json`, `package-lock.json`, `CHANGELOG.md`, and rebuilt tracked `dist/` files in the release commit.
6. **Tag + push (mandatory)** — `git tag -a vX.Y.Z -m "Release X.Y.Z" && git push origin main vX.Y.Z && git push slalom main vX.Y.Z`. Both remotes must carry the tag; verify `git show vX.Y.Z:package.json` has the same version. Untagged releases 0.100–0.115 had to be reconstructed from `git log -p -- package.json`.
7. **Export checks** — `npm run verify:exports && npm run check:contract && npm run verify:packed` (also run by `prepack`/`prepublishOnly`).

## `dist/` is tracked

Consumers pinned to a Git SHA receive the committed build. `prepare` skips
compilation when `dist/index.js` exists, so source-only fixes do not reach those
consumers. Build before the release, inspect `git diff --stat`, and commit every
changed generated file with the source. Verify an actual consumer install and
its runtime exports after repinning. Never patch only `dist/`.

## Historical lesson — v0.2.0 gotcha

The `realtime-modules-v0.2.0` tag was cut **without** running
`npm run build`. `dist/client/useAgentStream.{js,d.ts}` was missing
from the tag. `file:` consumers (gateway) were saved by the `prepare`
hook on install; OrgIQ adoption (commit `05f38c1` on aws-agentcore)
had to manually rebuild before the install resolved. Don't skip the
build step. The `prepublishOnly` script + this recipe exist to make
that mistake harder.
