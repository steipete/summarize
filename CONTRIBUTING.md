# Contributing

Focused fixes, tests, and documentation improvements are welcome.

## Setup

Requirements:

- Node.js 24 or newer
- pnpm 11.25.0 through Corepack
- Git

```bash
git clone https://github.com/<your-user>/summarize.git
cd summarize
corepack enable
corepack install
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
```

## Repository Layout

- `packages/core`: `@steipete/summarize-core`, the programmatic library surface
- `src`: CLI and daemon implementation
- `apps/chrome-extension`: Chrome Side Panel and Firefox Sidebar extension
- `tests`: CLI and core tests
- `docs`: user and architecture documentation
- `scripts`: build, documentation, and release tooling

Apps should import `@steipete/summarize-core` rather than the CLI package.

## Common Commands

```bash
pnpm run build
pnpm run check
pnpm run test
pnpm run test:coverage
pnpm run lint
pnpm run typecheck
pnpm run format
```

`pnpm run check` runs formatting, lint, type checking, and coverage tests. Run it before opening or updating a pull request. Installation already builds the CLI and core through `prepare`; run `pnpm run build` again after source changes.

Extension:

```bash
pnpm -C apps/chrome-extension typecheck
pnpm -C apps/chrome-extension build
pnpm -C apps/chrome-extension test:chrome
pnpm -C apps/chrome-extension test:firefox
```

The supported automated browser path is `test:chrome`. Firefox uses a temporary-install smoke test because Playwright cannot reliably drive `moz-extension://` pages.

The root `check` gate also type-checks the extension with bundler module resolution and WXT's generated browser declarations. Keep callback, settings, and message types tied to their owning modules so changes are checked across runtime boundaries.

Build and run the Node 24 CLI test container, including `ffmpeg` and `yt-dlp`:

```bash
docker build -f Dockerfile.test -t summarize-test .
docker run --rm summarize-test https://example.com --extract --plain
```

The image uses the workspace's pinned pnpm version and frozen lockfile, including local dependency patches.

Dependency patches live in `patches/` and have regression tests in `tests/dependency.*-security.test.ts`. The adm-zip 0.6.0 patch backports the destination-symlink extraction fix from 0.6.1 while that release completes the seven-day hold. It also stops asynchronous extraction after a directory rejection so the callback fires once; retain that correction until upstream fixes it, even after adopting 0.6.1. The image-size patch remains necessary until upstream publishes its parser-loop fixes. Registry audits still report patched versions by number, so verify the checked-in patches and tests rather than suppressing those advisories.

Daemon after extension or daemon changes:

```bash
pnpm -C apps/chrome-extension build
pnpm summarize daemon restart
pnpm summarize daemon status
```

## Changes

- Start from current `main`.
- Keep each pull request focused.
- Follow existing module boundaries and patterns.
- Add a regression test for bug fixes when practical.
- Update README or `docs/` for user-visible behavior.
- Do not edit `CHANGELOG.md`; maintainers add contributor entries when landing.
- Avoid new dependencies unless they are necessary and actively maintained.

Use Conventional Commits:

```text
feat: add a capability
fix: correct broken behavior
docs: clarify setup
test: cover a regression
refactor: simplify internals without changing behavior
```

## Pull Requests

Include:

- What changed and why
- Reproduction steps for bugs
- Tests and commands run
- Screenshots or recordings for visible UI changes
- Compatibility or migration impact, if any

All GitHub checks must pass before merge. Maintainers may adjust a contribution to fit project conventions while preserving author credit.

## Issues

Search existing issues first. Bug reports should include:

- Summarize version
- Node.js version
- Operating system
- Minimal reproduction steps
- Expected and actual behavior
- Relevant logs with secrets removed

Use [GitHub Issues](https://github.com/steipete/summarize/issues) for bugs and focused feature requests.
