# Releasing `@steipete/summarize` (npm + Homebrew/Bun)

Ship is **not done** until:

- npm is published
- GitHub Release has the Bun tarball asset
- GitHub Release has the Chrome extension zip
- GitHub Release has the Firefox extension zip
- Homebrew/core formula is updated + `brew install summarize` verifies

## Version sources (keep in sync)

- `package.json` `version`
- `packages/core/package.json` `version` (lockstep with CLI)
- `src/version.ts` `FALLBACK_VERSION` (needed for the Bun-compiled binary; it can’t read `package.json`)

## Fast path (recommended)

0. Preflight
   - Clean git: `git status`
   - Auth: `gh auth status`
   - npm auth must use the `$npm` tmux/1Password workflow with a temporary npmrc (`NPM_CONFIG_USERCONFIG`). Do not use raw `npm publish`.

1. Bump version + notes
   - Update version in:
     - `package.json`
     - `packages/core/package.json`
     - `src/version.ts` (`FALLBACK_VERSION`)
   - Update `CHANGELOG.md` (set the date + bullet notes under the new version header)

2. Gates (no warnings)
   - `pnpm -s install`
   - `pnpm -s check`
   - `pnpm -s build`

3. Build Bun artifact (prints sha256 + creates tarball)
   - `pnpm -s build:bun:test`
   - Artifacts: `dist-bun/summarize-macos-arm64-v<ver>.tar.gz`, `dist-bun/summarize-macos-x64-v<ver>.tar.gz`

4. Build Chrome extension artifact
   - `pnpm -C apps/chrome-extension build`
   - `mkdir -p dist-chrome`
   - `zip -r dist-chrome/summarize-chrome-extension-v<ver>.zip apps/chrome-extension/.output/chrome-mv3`

5. Build Firefox extension artifact
   - `pnpm -C apps/chrome-extension build:firefox`
   - `mkdir -p dist-firefox`
   - `cd apps/chrome-extension/.output/firefox-mv3 && zip -r -FS ../../../../dist-firefox/summarize-firefox-extension-v<ver>.zip . && cd -`
   - Verify: `unzip -l dist-firefox/summarize-firefox-extension-v<ver>.zip | head -20`

6. Publish to npm + smoke + promote
   - Use the helper only:
     ```bash
     scripts/release.sh publish
     ```
   - This publishes core first, then CLI, both with `pnpm publish --tag next`.
   - It blocks raw `npm publish` via `prepublishOnly`, verifies tarball metadata has no `workspace:*`, smokes the exact version with `pnpm dlx`, and only then promotes both packages to `latest`.
   - If exact-version smoke fails, do not tag or create a GitHub Release. Deprecate the broken CLI version and ship a patch:
     ```bash
     BAD_VERSION=<bad-version> DEPRECATE_MESSAGE="Broken package metadata. Use a newer version." scripts/release.sh deprecate
     ```

7. Tag

   ```bash
   ver="$(node -p 'require(\"./package.json\").version')"
   git tag -a "v${ver}" -m "v${ver}"
   git push --tags
   ```

8. GitHub Release + assets

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

   gh release create "v${ver}" \
     "dist-bun/summarize-macos-arm64-v${ver}.tar.gz" \
     "dist-bun/summarize-macos-x64-v${ver}.tar.gz" \
     "dist-chrome/summarize-chrome-extension-v${ver}.zip" \
     "dist-firefox/summarize-firefox-extension-v${ver}.zip" \
     --title "v${ver}" \
     --notes-file "/tmp/summarize-v${ver}-notes.md"
   ```

   - Verify notes render (real newlines): `gh release view v<ver> --json body --jq .body`

9. Homebrew/core verify
   - Homebrew/core is autobumped from the GitHub Release; this can lag the npm/GitHub release.
   - Verify when the formula catches up:
     ```bash
     scripts/release.sh homebrew
     brew install summarize
     summarize --version
     ```

## npm (npmjs)

Notes:

- npm may prompt for browser auth when `npm config get auth-type` is `web`. For scripted publishes, create auth in the `$npm` tmux/1Password workflow and pass OTP as `NPM_OTP` only when needed.
- Publishing with raw `npm publish` is forbidden here. Use `pnpm publish` only; it rewrites `workspace:*` dependencies in the packed CLI metadata.
- `scripts/release.sh publish` uses `next` first, then exact-version smoke, then `latest`. Tag/GitHub release come after that smoke passes.
- `prepare` runs `pnpm build` automatically during publish.

Helper: `scripts/release.sh` (phases: `gates|build|bun|chrome|firefox|verify|publish|smoke|promote|tag|github|homebrew|deprecate|all`).

## Homebrew (Bun-compiled binary w/ bytecode) - details

Goal:

- Build **macOS arm64 + x64** Bun binaries named `summarize`
- Package as `dist-bun/summarize-macos-<arch>-v<ver>.tar.gz`
- Upload tarball as a GitHub Release asset
- Homebrew/core autobump points the formula at those assets + sha256
- Formula should install the compiled `summarize` binary directly (no Bun wrapper script).

1. Build the Bun artifact
   - `pnpm build:bun:test`
   - This uses `bun build --compile --bytecode`, prints tarball sha256s, and smokes the host binary.

2. Smoke test locally (before uploading)
   - `dist-bun/summarize --version`
   - `dist-bun/summarize --help`
   - Optional: run one real file/link summary.

3. GitHub Release (when approved)
   - Create a release for tag `v<ver>` with clean notes (no duplicated version header inside the notes body):
     - Prefer `--title "v<ver>"` and `--notes-file …` (avoid pasting text with escaped `\\n`)
     - Notes should start with sections like `### Changes`, not `## v<ver>` (the release already has a title)
   - Upload `dist-bun/summarize-macos-arm64-v<ver>.tar.gz`
   - Upload `dist-bun/summarize-macos-x64-v<ver>.tar.gz`
   - Verify notes render correctly:
     - `gh release view v<ver> --json body --jq .body` (should show real newlines, not literal `\\n`)

4. Homebrew/core verification (after autobump)
   ```bash
   scripts/release.sh homebrew
   brew install summarize
   summarize --version
   ```

## Firefox Extension (Self-Hosted via AMO)

**Context**: This extension uses UUID-based extension ID `{284b5e44-952a-4aa3-8bd3-7ae89d741cde}` for team collaboration. The artifact is signed via Mozilla Add-ons (AMO) for self-distribution (not listed in AMO catalog).

**Building the artifact**:

```bash
# Via release script (recommended)
./scripts/release.sh firefox

# Or manually
pnpm -C apps/chrome-extension build:firefox
mkdir -p dist-firefox
cd apps/chrome-extension/.output/firefox-mv3 && \
  zip -r -FS ../../../../dist-firefox/summarize-firefox-extension-v<ver>.zip . && \
  cd -
```

**Verify artifact structure**:

```bash
# manifest.json must be at root level
unzip -l dist-firefox/summarize-firefox-extension-v<ver>.zip | head -20

# Verify UUID in manifest
unzip -p dist-firefox/summarize-firefox-extension-v<ver>.zip manifest.json | \
  python3 -m json.tool | grep -A 3 '"gecko"'

# Test integrity
unzip -t dist-firefox/summarize-firefox-extension-v<ver>.zip
```

**Sign via AMO (Self Distribution)**:

1. Login: https://addons.mozilla.org/developers/
2. Submit Add-on → **"On your own"** (self-distribution, not "On this site")
3. Upload: `dist-firefox/summarize-firefox-extension-v<ver>.zip`
4. Wait for automatic validation (~1-10 minutes, no manual review needed)
5. Download signed XPI: `summarize-<ver>.xpi`

**Install signed XPI**:

```bash
# Method 1: Drag & drop XPI into Firefox
# Method 2: File → Open File (Cmd+O) → select XPI
# Method 3: Open in Firefox: file:///path/to/summarize-<ver>.xpi
```

**Verify installation**:

- Extension appears in `about:addons`
- Sidebar: View → Sidebar → Summarize
- Keyboard shortcut: `Cmd+Shift+U` (macOS) / `Ctrl+Shift+U` (Linux/Windows)

**Managing co-authors** (after first upload):

1. AMO Developer Hub → [Your Add-on] → Settings → Manage Authors
2. Click "Add Author" → enter co-author's email
3. Co-author accepts invitation via email
4. Co-author can now upload updates (Developer or Owner role)

**Updating**:

1. Increment version in `package.json`
2. Rebuild: `pnpm -C apps/chrome-extension build:firefox`
3. Create new zip (same process as above)
4. Upload to AMO for signing (self-distribution, same URL)
5. Download new signed XPI
6. Install in Firefox (replaces old version automatically)

**Notes**:

- Self-hosted extensions do NOT auto-update through AMO
- For auto-updates: configure `update_url` in manifest (requires hosting update manifest)
- For personal/team use: manual updates are simpler
- Extension is NOT listed in AMO catalog (no reviews, no public stats)
