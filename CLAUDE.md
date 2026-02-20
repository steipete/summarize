# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Summarize is a link-to-summary tool: URL → clean text → LLM summary. It ships as a CLI (`@steipete/summarize`), a shared core library (`@steipete/summarize-core`), and a Chrome/Firefox browser extension.

## Monorepo Structure

- **Root** (`@steipete/summarize`) — CLI + UX (TTY, spinners, streaming progress). Depends on core.
- **packages/core** (`@steipete/summarize-core`) — Library surface for programmatic use. No CLI deps. Content extraction (readability, cheerio, jsdom), prompts, transcription, OpenAI helpers.
- **apps/chrome-extension** (`@steipete/summarize-chrome-extension`) — Browser extension built with WXT + Preact. Side panel UI with streaming chat agent.

Versioning is lockstep; publish order: core first, then CLI (`scripts/release.sh`).

## Commands

```bash
# Install
pnpm install

# Build (core → lib → cli)
pnpm build

# Quality gate (format check + lint + tests with coverage)
pnpm check

# Run CLI in dev
pnpm s <url>            # or: pnpm summarize <url>

# Tests
pnpm test               # vitest run
pnpm test:coverage      # with v8 coverage (75% threshold)

# Lint & format
pnpm lint               # oxlint (type-aware, enforces no-floating-promises)
pnpm lint:fix           # fix + format
pnpm format             # oxfmt only
pnpm format:check

# Type check
pnpm typecheck

# Browser extension
pnpm -C apps/chrome-extension dev            # watch mode
pnpm -C apps/chrome-extension build          # Chrome
pnpm -C apps/chrome-extension build:firefox  # Firefox
pnpm -C apps/chrome-extension test:chrome    # Playwright e2e

# Daemon
pnpm summarize daemon install --token <TOKEN>
pnpm summarize daemon status
pnpm summarize daemon restart
```

After extension changes, always rebuild + restart daemon in order:
1. `pnpm -C apps/chrome-extension build`
2. `pnpm summarize daemon restart`

## Testing

- **Framework:** Vitest with v8 coverage
- **Test location:** `tests/**/*.test.ts` (run from root)
- **Run a single test:** `pnpm vitest run tests/path/to/file.test.ts`
- **Setup:** `tests/setup.ts` disables local Whisper during tests
- **Timeouts:** 15s for both test and hook
- **Coverage excludes:** daemon, slides/extract, type barrels, index files
- **Workspace aliases** in vitest.config.ts map `@steipete/summarize-core/*` to source for dev

## Tooling

- **Node:** >=22 (required for ESM top-level await)
- **Package manager:** pnpm 10.25
- **TypeScript:** 5.9, strict mode, ES2023 target
- **Linter:** oxlint — only two rules enforced: `no-floating-promises` and `no-misused-promises` (both error)
- **Formatter:** oxfmt (config in `.oxfmtrc.jsonc`)
- **Build:** tsc for library emit, esbuild for CLI executable

## Architecture Notes

**Content extraction pipeline:** URL → fetch → extract (readability/cheerio) → clean → markdown. Smart routing for images, videos, audio, PDFs, transcripts. Fallback chain: direct fetch → Firecrawl → error.

**LLM integration:** Uses AI SDK (`@mariozechner/pi-ai`) for provider abstraction. Supports OpenAI, Anthropic, Google, xAI, NVIDIA, OpenRouter, and more. Model IDs use gateway format: `provider/model`. Auto mode with intelligent fallback (`src/model-auto.ts`).

**Config precedence:** CLI args > env vars > `~/.summarize/config.json` (JSON5) > defaults. Schema in `src/config.ts`.

**Daemon:** Background HTTP service on 127.0.0.1 with shared token auth. Manages streaming + media processing for the browser extension. Auto-start via launchd (macOS) / systemd (Linux).

## Conventions

- Commits: Conventional Commits (`type: message`)
- Import from apps: prefer `@steipete/summarize-core` to avoid pulling CLI-only deps
- Multiple agents may work in this folder concurrently (see AGENTS.md)
