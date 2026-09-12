# Summarize Guardrails

- Hard rule: single source of truth = `~/Projects/summarize`; never commit in `vendor/summarize` (treat it as a read-only checkout).
- Note: multiple agents often work in this folder. If you see files/changes you do not recognize, ignore them and list them at the end.

## Workspace layout (note)

- Monorepo (pnpm workspace).
- Packages:
  - `@steipete/summarize` = CLI + UX (TTY/progress/streaming). Depends on core.
  - `@steipete/summarize-core` (`packages/core`) = library surface for programmatic use (Sweetistics etc). No CLI entrypoints.
- Versioning: lockstep versions; publish order: core first, then CLI (`scripts/release.sh` / `RELEASING.md`).
- Homebrew/core formula is not owned here; BrewTestBot autobumps releases about every 3h. Do not block or manually manage it; ship and continue.
- Chrome Web Store: every release must upload the matching `dist-chrome/summarize-chrome-extension-v<version>.zip` to item `cejgnmmhbbpdmjnfppjdfkocebngehfg`, submit it for review with automatic publishing, and verify the exact pending/published version. Skip only when every shipped change is daemon-side and the packaged extension/companion contract is unchanged.
- Dev:
  - Build: `pnpm run build` (builds core first; also runs during install via `prepare`)
  - Gate: `pnpm run check`
  - Import from apps: prefer `@steipete/summarize-core` to avoid pulling CLI-only deps.
- Dependencies: stable releases need a 7-day stabilization delay before adoption; prereleases remain excluded unless already adopted.
- Daemon: restart with `pnpm summarize daemon restart`; verify via `pnpm summarize daemon status`.
- Rebuild (extension + daemon): run **both** in order:
  1. `pnpm -C apps/chrome-extension build`
  2. `pnpm summarize daemon restart`
- Extension tests:
  - `pnpm -C apps/chrome-extension test:chrome` = supported automated path.
  - Firefox Playwright extension tests are not reliable (`moz-extension://` limitation); default `test:firefox` runs a temporary-install smoke test.
  - Use `pnpm -C apps/chrome-extension test:firefox:force` only for explicit diagnostics.
- Commits: use `committer "type: message" <files...>` (Conventional Commits).
