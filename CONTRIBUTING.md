# Contributing

Focused fixes, tests, and documentation improvements are welcome.

## Setup

Requirements:

- Node.js 24 or newer
- pnpm 10.33.2 through Corepack
- Git

```bash
git clone https://github.com/<your-user>/summarize.git
cd summarize
corepack enable
corepack prepare pnpm@10.33.2 --activate
pnpm install --frozen-lockfile
pnpm -s build
pnpm -s check
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
pnpm -s build
pnpm -s check
pnpm -s test
pnpm -s test:coverage
pnpm -s lint
pnpm -s typecheck
pnpm -s format
```

`pnpm -s check` runs formatting, lint, type checking, and coverage tests. Run it before opening or updating a pull request.

Extension:

```bash
pnpm -C apps/chrome-extension build
pnpm -C apps/chrome-extension test:chrome
pnpm -C apps/chrome-extension test:firefox
```

The supported automated browser path is `test:chrome`. Firefox uses a temporary-install smoke test because Playwright cannot reliably drive `moz-extension://` pages.

Daemon after extension or daemon changes:

```bash
pnpm -C apps/chrome-extension build
pnpm -s summarize daemon restart
pnpm -s summarize daemon status
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
