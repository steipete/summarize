# Releasing `@steipete/summarize` (npm + Homebrew/Bun)

Hard rule: **do not publish, tag, or create GitHub releases without explicit approval**.
Release is **not done** until the Homebrew tap is bumped and a `brew install` verifies the new version.

## Version sources (keep in sync)

- `package.json` `version`
- `src/version.ts` `FALLBACK_VERSION` (needed for the Bun-compiled binary; it can’t read `package.json`)

## Gates (no warnings)

- `pnpm install`
- `pnpm check`
- `pnpm build`

## npm (npmjs)

1) Bump version (both places)
   - `package.json`
   - `src/version.ts`

2) Update notes
   - `CHANGELOG.md` (product-facing bullets)

3) Validate
   - Gates above
   - Optional: `npm pack --pack-destination /tmp` (don’t commit the tarball)

4) Publish (when approved)
   - `pnpm publish --access public`
   - Verify from a clean temp dir:
     ```bash
     rm -rf /tmp/summarize-npx && mkdir /tmp/summarize-npx && cd /tmp/summarize-npx
     npx -y @steipete/summarize@<ver> --version
     npx -y @steipete/summarize@<ver> --help
     ```

5) Tag (when approved)
   - `git tag -a v<ver> -m v<ver>`
   - `git push --tags`

Note: helper exists for npm-only flow: `scripts/release.sh` (phases: `gates|build|publish|smoke|tag|all`).
Prefer running `scripts/release.sh all` so publish + smoke + tag happen in one go (“ship all at once”).

## Homebrew (Bun-compiled binary w/ bytecode)

Goal:
- Build a **macOS universal** Bun binary named `summarize`
- Package as `dist-bun/summarize-macos-universal-v<ver>.tar.gz`
- Upload tarball as a GitHub Release asset
- Point Homebrew formula at that asset + sha256

1) Build the Bun artifact
   - `pnpm build:bun`
   - This uses `bun build --compile --bytecode` and prints the tarball sha256.

2) Smoke test locally (before uploading)
   - `dist-bun/summarize --version`
   - `dist-bun/summarize --help`
   - Optional: run one real file/link summary.

3) GitHub Release (when approved)
   - Create a release for tag `v<ver>`
   - Upload `dist-bun/summarize-macos-universal-v<ver>.tar.gz`

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
