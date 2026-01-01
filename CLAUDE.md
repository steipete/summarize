# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Summarize is a CLI tool and Chrome extension that extracts and summarizes content from URLs, files (PDFs, images, audio, video), YouTube videos, and podcasts. It uses various LLM providers (OpenAI, Anthropic, Google, xAI, Z.AI) with automatic fallback and supports streaming output.

## Development Commands

### Build & Test
```bash
# Install dependencies
pnpm install

# Full build (includes core package + CLI)
pnpm build

# Build individual parts
pnpm build:lib          # TypeScript library only
pnpm build:cli          # CLI wrapper
pnpm -C packages/core build  # Core package only

# Type checking
pnpm typecheck

# Linting & formatting
pnpm lint
pnpm lint:fix
pnpm format

# Run full quality gate
pnpm check              # Runs lint + test:coverage
```

### Testing
```bash
# Run all tests (requires build first)
pnpm test

# Run with coverage
pnpm test:coverage

# Run single test file
pnpm build && npx vitest run tests/cli.flags.test.ts

# Watch mode (requires build first)
pnpm build && npx vitest
```

### Development Workflow
```bash
# Run CLI during development (no build needed)
pnpm summarize <url-or-file>
pnpm s <url-or-file>           # Shorthand

# Use tsx directly
tsx src/cli.ts <url-or-file>
```

## Architecture

### Monorepo Structure

This is a pnpm workspace with two packages:
- **`@steipete/summarize`** (root): CLI + UX layer (TTY/progress/streaming/daemon)
- **`@steipete/summarize-core`** (`packages/core`): Library for programmatic use (content extraction, prompts, transcription)

**Important**: Versioning is lockstep. Publishing order: core first, then CLI (see `RELEASING.md` and `scripts/release.sh`).

### Entry Points

1. **CLI**: `src/cli.ts` → `src/cli-main.ts` → `src/run/runner.ts`
2. **Daemon**: `src/daemon/cli.ts` → `src/daemon/server.ts` (HTTP server for Chrome extension)
3. **Library exports**:
   - `@steipete/summarize-core/content` - Link preview client, transcript providers
   - `@steipete/summarize-core/prompts` - Prompt builders
   - `@steipete/summarize-core/language` - Language detection/normalization

### Core Flow Architecture

The CLI processes inputs through two main flow types:

#### 1. URL Flow (`src/run/flows/url/`)
Handles web pages, YouTube, podcasts, Twitter:
- **Extract** (`extract.ts`): Fetch → article extraction (Readability) → optional Firecrawl fallback
- **Markdown** (`markdown.ts`): HTML→Markdown or transcript→Markdown conversion (via LLM or readability)
- **Summary** (`summary.ts`): Build prompt → call LLM → stream output
- **Orchestration** (`flow.ts`): Coordinates the pipeline

#### 2. Asset Flow (`src/run/flows/asset/`)
Handles local files and remote file URLs:
- **Input** (`input.ts`): Detect file type, validate, load content
- **Preprocess** (`preprocess.ts`): Optional `markitdown` conversion (via `uvx`)
- **Summary** (`summary.ts`): Build attachments → call LLM → stream output

### Model System

**Model ID format**: `<provider>/<model>` (e.g., `openai/gpt-5-mini`, `anthropic/claude-sonnet-4-5`)

Key files:
- `src/llm/model-id.ts`: Parse/normalize gateway-style model IDs
- `src/model-spec.ts`: Model specifications and fixed vs auto selection
- `src/model-auto.ts`: Auto model selection with fallback chains
- `src/run/model-attempts.ts`: Build candidate attempts with retry logic
- `src/llm/generate-text.ts`: Unified LLM interface (uses AI SDK under the hood)

**Auto mode** (`--model auto`):
- Builds candidate list from `model.rules` (or defaults)
- Tries each candidate with retries/timeouts
- Falls back to OpenRouter when configured
- CLI providers (e.g., `gemini`) add ~4s latency; only used when explicitly enabled

**CLI providers**: Shell out to native CLI tools (e.g., `gemini` binary) as a fallback. Disabled by default in auto mode unless `cli.enabled` is set in config.

### Content Extraction (`packages/core/src/content/`)

**Link Preview** (`link-preview/`):
- `client.ts`: Main entry point, orchestrates fetching → extraction
- `content/article.ts`: Readability-based extraction
- `content/firecrawl.ts`: Firecrawl API integration (fallback for blocked sites)
- `content/youtube.ts`: YouTube metadata extraction
- `content/video.ts`: Generic video metadata (og:video)
- `content/podcast-utils.ts`: Apple Podcasts, Spotify detection

**Transcription** (`transcript/`):
- `providers/youtube.ts`: YouTube captions via `youtubei` API → `yt-dlp` + Whisper fallback → Apify (last resort)
- `providers/podcast/`: Apple Podcasts, Spotify, RSS feeds with Podcasting 2.0 transcript support
- `providers/generic.ts`: Direct media URL transcription

**Whisper transcription** (`packages/core/src/transcription/whisper/`):
- Prefers local `whisper.cpp` when available (via `SUMMARIZE_WHISPER_CPP_BINARY`)
- Falls back to OpenAI Whisper API (`OPENAI_API_KEY`) or FAL AI (`FAL_KEY`)
- Audio preprocessing via `ffmpeg` (converts to 16kHz mono WAV)

### Daemon & Chrome Extension

**Daemon** (`src/daemon/`):
- Localhost HTTP server (default port 9753)
- Token-based auth (shared between daemon and extension)
- SSE streaming for real-time summary updates
- Auto-start via platform-specific services:
  - macOS: launchd (`launchd.ts`)
  - Linux: systemd user (`systemd.ts`)
  - Windows: Scheduled Tasks (`schtasks.ts`)

**Chrome Extension** (`apps/chrome-extension/`):
- Built with WXT framework (see `wxt.config.ts`)
- Side panel UI streams summaries from daemon
- Content scripts extract visible page content
- Two modes: Manual trigger or Auto-summarize on navigation

**Pairing flow**:
1. Extension generates token, displays install command
2. User runs: `summarize daemon install --token <TOKEN>`
3. Daemon stores token, starts service
4. Extension connects via localhost:9753 with Bearer auth

**Daemon Configuration & Troubleshooting**:

The daemon runs in a separate process via platform services (launchd/systemd/schtasks) and doesn't inherit shell environment variables.

**Configuration files**:
- `~/.summarize/daemon.json` - Daemon-specific config (port, token, environment variables)
- `~/.summarize/config.json` - Application config (model, logging, timeouts)

**Environment variables** (set in `~/.summarize/daemon.json` under `env` key):
```json
{
  "env": {
    "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    "YT_DLP_PATH": "/opt/homebrew/bin/yt-dlp",
    "SUMMARIZE_WHISPER_CPP_BINARY": "/opt/homebrew/bin/whisper-cli",
    "SUMMARIZE_WHISPER_CPP_MODEL_PATH": "/path/to/ggml-model.bin"
  }
}
```

**Logging** (configured in `~/.summarize/config.json`):
```json
{
  "logging": {
    "enabled": true,
    "level": "info",
    "format": "pretty"
  }
}
```
- Levels: `debug`, `info`, `warn`, `error`
- Formats: `pretty` (human-readable), `json` (structured)
- Log files: `~/.summarize/logs/daemon.{log,err.log,jsonl}`

**Timeouts** (default: 120 seconds):
```json
{
  "timeout": "5m"
}
```
Formats: `"5m"`, `"30s"`, or number in seconds

**Common issues**:
- **"Missing transcription provider"**: Add `YT_DLP_PATH`, `SUMMARIZE_WHISPER_CPP_BINARY`, and `SUMMARIZE_WHISPER_CPP_MODEL_PATH` to daemon.json env
- **Extension not connecting**: Check daemon status (`summarize daemon status`), verify port in daemon.json matches extension
- **No logs**: Enable logging in config.json, restart daemon
- **Requests timing out**: Increase timeout in config.json

**Useful commands**:
```bash
summarize daemon status
summarize daemon restart
tail -f ~/.summarize/logs/daemon.jsonl
lsof -i :8787  # Check daemon port
```

### Streaming & Output

**TTY Rendering** (`src/tty/`, `src/run/streaming.ts`):
- Markdown → ANSI via `markdansi` (hybrid streaming: line-by-line, buffers code blocks/tables)
- OSC progress protocol (`osc-progress.ts`) for terminal-integrated progress bars
- Spinner fallback for non-OSC terminals

**Finish line** (`src/run/finish-line.ts`):
- Single-line summary: timing, token usage, cost estimate (when pricing available)
- Uses LiteLLM catalog for model limits/pricing (cached at `~/.summarize/cache/`)

### Configuration

**Location**: `~/.summarize/config.json`

**Parsing**: JSON5 (lenient), but comments are not allowed. Unknown keys ignored.

**Precedence**: CLI flags → `SUMMARIZE_MODEL` env var → config file → default (`auto`)

Key settings:
- `model`: Model spec (string or object with `id`/`mode`)
- `models`: Named presets (selectable via `--model <preset>`)
- `model.rules`: Customize auto-mode candidate ordering
- `cli.enabled`: Array of CLI providers to enable (e.g., `["gemini"]`)
- `cache.path`: Cache directory override

### Cache System

**Location**: `~/.summarize/cache/` (configurable via `cache.path`)

**What's cached**:
- Extracted content (HTML → text/Markdown)
- Transcripts (YouTube captions, podcast transcripts)
- Summaries (keyed by URL + model + prompt hash)
- LiteLLM model catalog (pricing/limits)

**Cache keys** (`src/cache.ts`): SHA-256 hashes of normalized inputs

**Management**:
- `--clear-cache`: Wipe all cached data
- Auto-cleanup: LRU eviction when cache exceeds `DEFAULT_CACHE_MAX_MB` (500 MB)

## Key Patterns

### Error Handling
- Fast-fail with friendly messages (no mystery stack traces)
- Provider-specific media type validation (`assertAssetMediaTypeSupported`)
- Timeout handling with retries (configurable via `--timeout`, `--retries`)

### Testing
- Tests use fixture-based mocks for LLM calls (see `tests/fixtures/`)
- Daemon tests excluded from coverage (integration-tested manually)
- OS/browser integration excluded (e.g., `twitter-cookies-*.ts`)
- Coverage thresholds: 75% (branches, functions, lines, statements)

### Type Safety
- Strict TypeScript (`tsconfig.base.json` extends strict)
- Dual linters: Biome (primary) + oxlint (type-aware)
- No `any` types in new code

## Important Constraints

1. **Single source of truth**: `~/Projects/summarize` (never commit in `vendor/summarize` - see `AGENTS.md`)
2. **Build before test**: Tests require `pnpm build` first (imports from `dist/`)
3. **Lockstep versioning**: Sync versions across `package.json`, `packages/core/package.json`, and `src/version.ts`
4. **Node 22+ required**: Uses recent Node APIs (e.g., `fetch`, native test runner)

## Browser Extension Development

The extension supports both Chrome and Firefox via WXT's multi-browser build system.

### Chrome Development

```bash
# Build extension (from repo root)
pnpm -C apps/chrome-extension build

# Development mode (watch)
pnpm -C apps/chrome-extension dev

# Load unpacked in Chrome
# 1. chrome://extensions → Developer mode ON
# 2. Load unpacked: apps/chrome-extension/.output/chrome-mv3

# Run Chrome-specific tests
pnpm -C apps/chrome-extension test:chrome
```

### Firefox Development

```bash
# Build Firefox extension
pnpm -C apps/chrome-extension build:firefox

# Development mode (watch)
pnpm -C apps/chrome-extension dev:firefox

# Load temporary add-on in Firefox
# 1. about:debugging#/runtime/this-firefox
# 2. Load Temporary Add-on
# 3. Select: apps/chrome-extension/.output/firefox-mv3/manifest.json

# Run Firefox-specific tests
pnpm -C apps/chrome-extension test:firefox

# Build both browsers
pnpm -C apps/chrome-extension build:all
```

**Firefox compatibility notes**:
- Requires Firefox 131+ for native sidebar support
- Uses `sidebar_action` instead of Chrome's `side_panel`
- Sidebar opens manually (no programmatic control)
- Same codebase, browser-specific manifest overrides in `wxt.config.ts`
- See `apps/chrome-extension/docs/firefox.md` for detailed compatibility info

### Testing Both Browsers

```bash
# Run all tests (both browsers)
pnpm -C apps/chrome-extension test
```

## Release Process

See `RELEASING.md` for full details. Key steps:

1. Bump versions in 3 places: `package.json`, `packages/core/package.json`, `src/version.ts`
2. Update `CHANGELOG.md`
3. Run gates: `pnpm check && pnpm build`
4. Build artifacts: `pnpm build:bun:test` (Homebrew) + extension zip
5. Tag & create GitHub Release with artifacts
6. Update Homebrew tap (`~/Projects/homebrew-tap`)
7. Publish to npm: core first, then CLI
8. Smoke test: `pnpm dlx @steipete/summarize@<ver> --version`
