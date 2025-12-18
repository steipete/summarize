# Changelog

All notable changes to this project are documented here.

## 0.1.0 - 2025-12-17

- CLI `summarize` (global install) + reusable library exports in `@steipete/summarize`.
- Website extraction: fetch HTML → extract “article-ish” content → normalize for prompts.
- Firecrawl fallback for blocked/thin sites (`--firecrawl off|auto|always`, requires `FIRECRAWL_API_KEY`).
- YouTube extraction (`--youtube auto|web|apify`):
  - `youtubei` transcript endpoint (best-effort)
  - `captionTracks` timedtext extraction (best-effort)
  - optional Apify fallback (requires `APIFY_API_TOKEN`)
  - fallback to `ytInitialPlayerResponse.videoDetails.shortDescription` when transcripts are unavailable
- LLM summarization:
  - Default model: `xai/grok-4-fast-non-reasoning` (direct provider API keys; no gateway).
  - Override via config file (`model`), `SUMMARIZE_MODEL`, or `--model`.
  - Supports `xai/...`, `openai/...`, and `google/...` model ids.
- `--extract-only` prefers Firecrawl Markdown for websites when `FIRECRAWL_API_KEY` is configured (override via `--firecrawl off`).
- `--extract-only --markdown auto|llm` can convert HTML → Markdown via an LLM using the configured `--model`.
- CLI defaults: `--timeout 2m`.
- `--help` includes examples and required env vars.
- `--extract-only` (no LLM call), `--prompt` (prompt-only), `--json` (structured output), `--verbose`.
- Tests + coverage gate (>= 75%) via Vitest + v8 coverage; lint/format via Biome.
