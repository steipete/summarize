# Releasing `@steipete/summarize` (npm + Homebrew/Bun)

A release is **not done** until:

- npm is published
- GitHub Release has both Developer ID-signed and Apple-notarized Bun tarball assets
- GitHub Release has the Chrome extension zip
- GitHub Release has the Firefox extension zip
- GitHub Release has `SHA256SUMS` for the exact CI-verified assets
- The matching Chrome extension is submitted for review with automatic publishing and its exact pending/published version is verified, unless all shipped changes are daemon-only and the packaged extension/companion contract is unchanged. See [Chrome Web Store submission](docs/releasing.md#checklist).

Homebrew/core autobumps independently. Do not block a completed release on that lag or manually rewrite the formula; verification is an optional follow-up once it catches up.

## Version sources (keep in sync)

- `package.json` `version`
- `packages/core/package.json` `version` (lockstep with CLI)
- `src/version.ts` `FALLBACK_VERSION` (needed for the Bun-compiled binary; it can’t read `package.json`)

## Fast path (recommended)

To validate the current version on merged `main` without creating tags or publishing, run `gh workflow run release.yml --repo steipete/summarize --ref main -f version=0.25.3 -F dry_run=true`. Manual runs require dry-run mode; they build, sign, notarize, and independently verify both macOS archives, but skip npm and GitHub publication. Package manifests are verified in every run; comparison with already-published npm bytes applies only to tag releases, since a dry run may test changed source at the current version.

macOS builds and verification use Apple Silicon `xcode-27` runners. The x86_64 verifier explicitly uses Rosetta. CI builds both architectures and checks their Mach-O minimum remains at most macOS 13.0; `MACOSX_DEPLOYMENT_TARGET=13.0` is explicit in both build jobs.

0. Preflight
   - Clean git: `git status`
   - Auth: `gh auth status`
   - npm trusted publishers must be configured for both packages: GitHub repository `steipete/summarize`, workflow `release.yml`, no environment. Use the `$npm` tmux/1Password helper for one-time configuration; release publishing needs no npm token.

1. Bump version + notes
   - Update version in:
     - `package.json`
     - `packages/core/package.json`
     - `src/version.ts` (`FALLBACK_VERSION`)
   - Update `CHANGELOG.md` (set the date + bullet notes under the new version header)

2. Gates (no warnings)
   - `pnpm install`
   - `pnpm check`
   - `pnpm build`

3. Build Bun artifact locally (unsigned smoke proof only)
   - `pnpm build:bun:test`
   - Artifacts: `dist-bun/summarize-macos-arm64-v<ver>.tar.gz`, `dist-bun/summarize-macos-x64-v<ver>.tar.gz`
   - Local artifacts are not releasable. The tag-triggered Release workflow rebuilds the frozen source, signs and notarizes both Mach-O executables, and packages those CI-produced bytes.

4. Build Chrome extension artifact
   - `scripts/release.sh chrome`
   - The helper packages the extension contents with `manifest.json` at the ZIP root, as required by the Chrome Web Store.

5. Build Firefox extension artifact
   - `pnpm -C apps/chrome-extension build:firefox`
   - `mkdir -p dist-firefox`
   - `cd apps/chrome-extension/.output/firefox-mv3 && zip -r -FS ../../../../dist-firefox/summarize-firefox-extension-v<ver>.zip . && cd -`
   - Verify: `unzip -l dist-firefox/summarize-firefox-extension-v<ver>.zip | head -20`

6. Verify local packages
   - `scripts/release.sh verify` packs with pnpm, checks both manifests (including the exact core dependency and no `workspace:` references), installs both tarballs into a temporary prefix, and exercises the CLI and FFmpeg fallback.
   - Local builds are proof only; CI rebuilds the frozen tagged source.

7. Push a signed annotated tag after the release commit has green push CI

   ```bash
   scripts/release.sh tag
   ```

   - Configure Git SSH signing with the `Release - Git tag SSH signing key - all repos` 1Password item through the approved secret workflow. The helper uses `git tag -s` and pushes only the release tag.
   - The tag must match all three version sources, point to a commit reachable from `main`, and already have successful push CI.
   - `scripts/release.sh all` runs the local gates, builds proof artifacts, verifies packages, and pushes this signed tag.

8. CI publishes npm and GitHub Release; verify locally afterward
   - `.github/workflows/release.yml` validates the tag and npm state, builds and notarizes both macOS binaries, and verifies each archive on its native architecture without signing credentials.
   - Each verifier checks `otool -l` `LC_BUILD_VERSION` against the macOS 13.0 baseline. Use upstream Bun; Homebrew builds can carry a newer minimum OS version.
   - After both macOS verifiers pass, the npm job rebuilds and packs core and CLI with the frozen pnpm lockfile. It checks manifests and smoke-installs both exact tarballs before publishing either one.
   - npm trusted publishing uses GitHub OIDC with Node 24 and npm >=11.5.1, without `NODE_AUTH_TOKEN` or a long-lived npm token. Stable releases publish directly to `latest`; prereleases use `next`. OIDC cannot promote dist-tags afterward.
   - Existing versions are accepted only when their integrity and downloaded bytes exactly match this run's build. A mismatch or registry error fails the release. A rerun can resume after core succeeds and CLI fails without republishing core.
   - CI checks both npm provenance attestations and runs `npm audit signatures` before creating the GitHub Release from the exact verified archives and checksums.
   - Rerun failed Release jobs in GitHub Actions for a partial publication. Never retag a release after any package or artifact has been published; fix forward with a patch release if the frozen source must change.

   ```bash
   scripts/release.sh smoke
   scripts/release.sh promote # read-only dist-tag verification
   scripts/release.sh github
   gh release view v<ver> --json body --jq .body
   ```

9. Optional Homebrew/core follow-up
   - Homebrew/core is autobumped from the GitHub Release; this can lag the npm/GitHub release and does not block closeout.
   - Verify when the formula catches up:
     ```bash
     scripts/release.sh homebrew
     brew install summarize
     summarize --version
     ```

## npm (npmjs)

The tag-triggered Release workflow is the only npm publisher. Source-directory publishing and the legacy `publish` / `publish-cli` phases are disabled; there is no local fallback. `pnpm pack` rewrites workspace dependencies before CI publishes the resulting tarballs with `npm publish --ignore-scripts`.

For one-time trusted-publisher setup, run the `$npm` helper in the shared `op-work` tmux task window for each of `@steipete/summarize-core` and `@steipete/summarize`:

```bash
npm-service.sh -- trust github <package> --repo steipete/summarize --file release.yml --allow-publish --yes
npm-service.sh -- trust list <package> --json
```

Do not set an environment name unless the workflow also uses that environment. Configuration uses the saved npm session/OTP; CI publication uses OIDC only. `scripts/release.sh smoke`, `promote`, and `github` are read-only verification phases. `deprecate` remains an explicit emergency registry operation and requires the `$npm` credential workflow.

Helper phases: `gates|build|bun|chrome|firefox|pack|verify|smoke|promote|tag|github|homebrew|deprecate|all`.

## Homebrew (Bun-compiled binary w/ bytecode) - details

Goal:

- Build **macOS arm64 + x64** Bun binaries named `summarize`
- Package as `dist-bun/summarize-macos-<arch>-v<ver>.tar.gz`
- Upload tarball as a GitHub Release asset
- Homebrew/core autobump points the formula at those assets + sha256
- Formula should install the compiled `summarize` binary directly (no Bun wrapper script).

1. Build the Bun artifact
   - `pnpm build:bun:test`
   - This uses `bun build --compile --bytecode`, prints tarball sha256s, and smokes the host binary. Without `SUMMARIZE_OFFICIAL_RELEASE=1`, these are local proof artifacts only.

2. Smoke test locally (before uploading)
   - `dist-bun/summarize --version`
   - `dist-bun/summarize --help`
   - Optional: run one real file/link summary.

3. GitHub Release (when approved)
   - Push the signed annotated `v<ver>` tag. The Release workflow is the only supported publisher.
   - Each Bun executable is signed after compilation with `Developer ID Application: Peter Steinberger (Y5PE65HELJ)`, identifier `com.steipete.summarize.cli`, hardened runtime, a trusted timestamp, and the two Bun JIT entitlements in `scripts/macos-release.entitlements`.
   - Apple notarization is submitted for each signed executable. Raw Mach-O files cannot carry stapled tickets, so both CI verifiers require `codesign --check-notarization -R=notarized` online.
   - The browser extension zips and npm tarballs contain no Mach-O and stay outside Apple signing.
   - Repository secrets are `MACOS_SIGNING_P12`, `MACOS_SIGNING_P12_PASSWORD`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_PRIVATE_KEY_P8`. Never pass them to verifier jobs.

4. Homebrew/core verification (after autobump)
   ```bash
   scripts/release.sh homebrew
   brew install summarize
   summarize --version
   ```

## Firefox Extension (Self-Hosted via AMO)

**Context**: Firefox builds declare the extension ID `summarize-test@steipete.com`, also used by previous releases. Preserve that identity when submitting updates to Mozilla Add-ons (AMO) for self-distribution (not listed in the AMO catalog); the GitHub ZIP must be signed through AMO before regular Firefox installation.

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
