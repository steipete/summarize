# Releasing `@steipete/summarize` (npm + Homebrew/Bun)

Ship is **not done** until:
- npm is published
- GitHub Release has the Bun tarball asset
- Homebrew tap is bumped + `brew install` verifies

## Version sources (keep in sync)

- `package.json` `version`
- `packages/core/package.json` `version` (lockstep with CLI)
- `src/version.ts` `FALLBACK_VERSION` (needed for the Bun-compiled binary; it can’t read `package.json`)

## Fast path (recommended)

0) Preflight
   - Clean git: `git status`
   - Auth: `gh auth status`, `npm whoami`

1) Bump version + notes
   - Update version in:
     - `package.json`
     - `packages/core/package.json`
     - `src/version.ts` (`FALLBACK_VERSION`)
   - Update `CHANGELOG.md` (set the date + bullet notes under the new version header)

2) Gates (no warnings)
   - `pnpm -s install`
   - `pnpm -s check`
   - `pnpm -s build`

3) Build Bun artifact (prints sha256 + creates tarball)
   - `pnpm -s build:bun:test`
   - Artifact: `dist-bun/summarize-macos-arm64-v<ver>.tar.gz`

4) Tag
   ```bash
   ver="$(node -p 'require(\"./package.json\").version')"
   git tag -a "v${ver}" -m "v${ver}"
   git push --tags
   ```

5) GitHub Release + asset
   ```bash
   ver="$(node -p 'require(\"./package.json\").version')"

   # Notes = full changelog section(s), but without a duplicated version header.
   # If you skipped GitHub Releases for some versions, set prev to the last released version
   # and include all sections since then.
   prev="0.6.1"

   awk -v start="$ver" -v stop="$prev" '
     BEGIN { p=0 }
     $0 ~ ("^## " start " ") { p=1; next }
     $0 ~ ("^## " stop " ") { p=0 }
     p { print }
   ' CHANGELOG.md >"/tmp/summarize-v${ver}-notes.md"

   gh release create "v${ver}" "dist-bun/summarize-macos-arm64-v${ver}.tar.gz" \
     --title "v${ver}" \
     --notes-file "/tmp/summarize-v${ver}-notes.md"
   ```
   - Verify notes render (real newlines): `gh release view v<ver> --json body --jq .body`

6) Homebrew tap bump + verify
   - Repo: `~/Projects/homebrew-tap`
   - Update `Formula/summarize.rb`:
     - `url` → GitHub Release asset URL
     - `sha256` → from `pnpm build:bun:test`
     - `version` + test expectation
   - `git commit -am "chore: bump summarize to <ver>" && git push`
   - Verify:
     ```bash
     brew uninstall summarize || true
     brew tap steipete/tap || true
     brew install steipete/tap/summarize
     summarize --version
     ```

7) Publish to npm + smoke
   - If npm asks for OTP:
     - `npm_config_auth_type=legacy pnpm publish --tag latest --access public --otp <otp>`
   - Otherwise:
     - Publish core first, then CLI:
       - `pnpm -C packages/core publish --tag latest --access public`
       - `pnpm publish --tag latest --access public`
   - If the CLI forces browser auth, prefer the legacy path above by sourcing `~/.profile`
     (must include `NODE_AUTH_TOKEN`) before running the publish command.
   - Smoke:
     ```bash
     ver="$(node -p 'require(\"./package.json\").version')"
     npm view @steipete/summarize version
     npm view @steipete/summarize-core version
     pnpm -s dlx @steipete/summarize@"${ver}" --version
     pnpm -s dlx @steipete/summarize@"${ver}" --help >/dev/null
     ```

## npm (npmjs)

Notes:
- npm may prompt for browser auth when `npm config get auth-type` is `web`. For scripted publishes, use `npm_config_auth_type=legacy` + `--otp`.
- `prepare` runs `pnpm build` automatically during publish.

Helper (npm-only): `scripts/release.sh` (phases: `gates|build|publish|smoke|tag|all`).

## Homebrew (Bun-compiled binary w/ bytecode) - details

Goal:
- Build a **macOS arm64** Bun binary named `summarize`
- Package as `dist-bun/summarize-macos-arm64-v<ver>.tar.gz`
- Upload tarball as a GitHub Release asset
- Point Homebrew formula at that asset + sha256
- Formula should install the compiled `summarize` binary directly (no Bun wrapper script).

1) Build the Bun artifact
   - `pnpm build:bun`
   - This uses `bun build --compile --bytecode` and prints the tarball sha256.

2) Smoke test locally (before uploading)
   - `dist-bun/summarize --version`
   - `dist-bun/summarize --help`
   - Optional: run one real file/link summary.

3) GitHub Release (when approved)
   - Create a release for tag `v<ver>` with clean notes (no duplicated version header inside the notes body):
     - Prefer `--title "v<ver>"` and `--notes-file …` (avoid pasting text with escaped `\\n`)
     - Notes should start with sections like `### Changes`, not `## v<ver>` (the release already has a title)
   - Upload `dist-bun/summarize-macos-arm64-v<ver>.tar.gz`
   - Verify notes render correctly:
     - `gh release view v<ver> --json body --jq .body` (should show real newlines, not literal `\\n`)

4) Homebrew tap update (when approved + after asset is live)
   - Repo: `~/Projects/homebrew-tap`
   - Add/update `Formula/summarize.rb`:
     - `url` = GitHub Release asset URL
     - `sha256` = from step (1)
     - `version` = `<ver>`

5) Homebrew verification (after formula update)
   ```bash
   brew uninstall summarize || true
   brew tap steipete/tap || true
   brew install steipete/tap/summarize
   summarize --version
   ```
