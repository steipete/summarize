# Changelog

## 0.8.0 - Unreleased

### Breaking

- ESM-only: `@steipete/summarize` + `@steipete/summarize-core` no longer support CommonJS `require()`; the CLI binary is now ESM.

## 0.7.1 - 2025-12-26

### Fixed

- Packaging: `@steipete/summarize-core` now ships a CJS build for `require()` consumers (fixes `pnpm dlx @steipete/summarize --help` and the published CLI runtime).

## 0.7.0 - 2025-12-26

### Highlights

- Packages: split into `@steipete/summarize-core` (library) + `@steipete/summarize` (CLI; depends on core). Versions are lockstep.
- Streaming: scrollback-safe Markdown streaming (hybrid: line-by-line + block buffering for fenced code + tables). No cursor control, no full-frame redraws.
- Output: Markdown rendering is automatic on TTY; use `--plain` for raw Markdown/text output.
- Finish line: compact separators (`·`) and no duplicated `… words` when transcript stats are shown.
- YouTube: `--youtube auto` prefers `yt-dlp` transcription when available; Apify is last-last resort.

### Fixed

- Streaming: flush newline-bounded output in `--plain` mode to avoid duplication with cumulative stream chunks.
- Website extraction: strip inline CSS before Readability to avoid extremely slow jsdom stylesheet parsing on some pages.
- Twitter/X: rotate Nitter hosts and skip Anubis PoW pages during tweet fallback.

### Changed

- CLI: remove `--render`; add `--plain` to keep raw output (no ANSI/OSC rendering).

## 0.6.1 - 2025-12-25

### Changes

- YouTube: `--youtube auto` now falls back to `yt-dlp` if it’s on `PATH` (or `YT_DLP_PATH` is set) and a Whisper provider is available.
- `--version` now includes a short git SHA when available (build provenance).
- `--extract` now defaults to Markdown output (when `--format` is omitted), preferring Readability input.
- `--extract` no longer spends LLM tokens for Markdown conversion by default (unless `--markdown-mode llm` is used).
- `--format md` no longer forces Firecrawl; use `--firecrawl always` to force it.
- Finish line in `--extract` shows the extraction path (e.g. `markdown via readability`) and omits noisy `via html` output.
- Finish line always includes the model id when an LLM is used (including `--extract --markdown-mode llm`).
- `--extract` renders Markdown in TTY output (same renderer as summaries) when `--render auto|md` (use `--render plain` for raw Markdown).
- Suppress transcript progress/failure messages for non-YouTube / non-podcast URLs.
- Streaming now works with auto-selected models (including `--model free`) when `--stream on|auto`.
- Warn when `--length` is explicitly provided with `--extract` (ignored; no summary is generated).

## 0.6.0 - 2025-12-25

### Features

- **Podcasts (full episodes)**
  - Support Apple Podcasts episode URLs via iTunes Lookup + enclosure transcription (avoids slow/blocked HTML).
  - Support Spotify episode URLs via the embed page (`/embed/episode/...`) to avoid recaptcha; fall back to iTunes RSS when embed audio is DRM/missing.
  - Prefer local `whisper.cpp` when installed + model available (no API keys required for transcription).
  - Whisper transcription works for any media URL (audio/video containers), not just YouTube.
- **Language**
  - Add `--language/--lang` (default: `auto`, match source language).
  - Add config support via `output.language` (legacy `language` still supported).
- **Progress UI**
  - Add two-phase progress for podcasts: media download + Whisper transcription progress.
  - Show transcript phases (YouTube caption/Apify/yt-dlp), provider + model, and media size/duration.

### Changes

- **Transcription**
  - Add lenient ffmpeg transcode fallback for local Whisper when strict decode fails (e.g. Spotify AAC).

- **Models**
  - Add `zai/...` model alias with Z.AI base URL + chat completions by default.
  - Add `OPENAI_USE_CHAT_COMPLETIONS` + `openai.useChatCompletions` config toggle.
- **Metrics / output**
  - `--metrics on|detailed`: finish line includes compact transcript stats (… words, …) + media duration (when available); `--metrics detailed`: also prints input/transcript sizes + transcript source/provider/cache; hides `calls=1`.
  - Smarter duration formatting (`1h 13m 4s`, `44s`) and rounded transfer rates.
  - Make Markdown links terminal-clickable by materializing URLs.
  - `--metrics on|detailed` renders a single finish line with a compact transcript block (… words, …) before the model.
- **Cost**
  - Include OpenAI Whisper transcription estimate (duration-based) in the finish line total (`txcost=…`); configurable via `openai.whisperUsdPerMinute`.

### Docs

- Add `docs/language.md` and document language config + flag usage.

### Tests

- Add JSON-LD graph extraction coverage.
- Extend live podcast-host coverage (Podchaser, Spreaker, Buzzsprout).
- Raise global branch coverage threshold to 75% and add regression coverage for podcast/language/progress paths.

## 0.5.0 - 2025-12-24

### Features

- **Model selection & presets**
  - Automatic model selection (`--model auto`, now the default):
    - Chooses models based on input kind (website/YouTube/file/image/video/text) and prompt size.
    - Skips candidates without API keys; retries next model on request errors.
    - Adds OpenRouter fallback attempts when `OPENROUTER_API_KEY` is present.
    - Shows the chosen model in the progress UI.
  - Named model presets via config (`~/.summarize/config.json` → `models`), selectable as `--model <preset>`.
  - Built-in preset: `--model free` (OpenRouter `:free` candidates; override via `models.free`).
- **OpenRouter free preset maintenance**
  - `summarize refresh-free` regenerates `models.free` by scanning OpenRouter `:free` models and testing availability + latency.
  - `summarize refresh-free --set-default` also sets `"model": "free"` in `~/.summarize/config.json` (so free becomes your default).
- **CLI models**
  - Add `--cli <provider>` flag (equivalent to `--model cli/<provider>`).
  - `--cli` accepts case-insensitive providers and can be used without a provider to enable CLI auto selection.
- **Content extraction**
  - Website extraction detects video-only pages:
    - YouTube embeds switch to transcript extraction automatically.
    - Direct video URLs can be downloaded + summarized when `--video-mode auto|understand` and a Gemini key is available.
- **Env**
  - `.env` in the current directory is loaded automatically (so API keys work without exporting env vars).

### Changes

- **CLI config**
  - Auto mode uses CLI models only when `cli.enabled` is set; order follows the list.
  - `cli.enabled` is an allowlist for CLI usage.
- **OpenRouter**
  - Stop sending extra routing headers.
  - `--model free`: when OpenRouter rejects routing with “No allowed providers”, print the exact provider names to allow and suggest running `summarize refresh-free`.
  - `--max-output-tokens`: when explicitly set, it is also forwarded to OpenRouter calls.
- **Refresh Free**
  - Default extra runs reduced to 2 (total runs = 1 + runs) to reduce rate-limit pressure.
  - Filter `:free` candidates by recency (default: last 180 days; configurable via `--max-age-days`).
  - Print `ctx`/`out` in `k` units for readability.
- **Defaults**
  - Default summary length is now `xl`.

### Fixes

- **LLM / OpenRouter**
  - LLM request retries (`--retries`) and clearer timeout errors.
  - `summarize refresh-free`: detect OpenRouter free-model rate limits and back off + retry.
- **Streaming**
  - Normalize + de-dupe overlapping chunks to prevent repeated sections in live Markdown output.
- **YouTube**
  - Prefer manual captions over auto-generated when both exist. Thanks @dougvk.
  - Always summarize YouTube transcripts in auto mode (instead of printing the transcript).
- **Prompting & metrics**
  - Don’t “pad” beyond input length when asking for longer summaries.
  - `--metrics detailed`: fold metrics into finish line and make labels less cryptic.

### Docs

- Add documentation for presets and Refresh Free.
- Add a “make free the default” quick start for `summarize refresh-free --set-default`.
- Add a manual end-to-end checklist (`docs/manual-tests.md`).
- Add a quick CLI smoke checklist (`docs/smoketest.md`).
- Document CLI ordering and model selection behavior.

### Tests

- Add coverage for presets and Refresh Free regeneration.
- Add live coverage for the `free` preset.
- Add regression coverage for YouTube transcript handling and metrics formatting.

## 0.4.0 - 2025-12-21

### Changes

- Add URL extraction mode via `--extract` with `--format md|text`.
- Rename HTML→Markdown conversion flag to `--markdown-mode`.
- Add `--preprocess off|auto|always` and a `uvx markitdown` fallback for Markdown extraction and unsupported file attachments (when `--format md` is used).

## 0.3.0 - 2025-12-20
### Changes

- Add yt-dlp audio transcription fallback for YouTube; prefer OpenAI Whisper with FAL fallback. Thanks @dougvk.
- Add `--no-playlist` to yt-dlp downloads to avoid transcript mismatches.
- Run yt-dlp after web + Apify in `--youtube auto`, and error early for missing keys in `--youtube yt-dlp`.
- Require Node 22+.
- Respect `OPENAI_BASE_URL` when set, even with OpenRouter keys.
- Add OpenRouter configuration tests. Thanks @dougvk for the initial OpenRouter support.
- Build and ship a Bun bytecode arm64 binary for Homebrew.

### Tests

- Add coverage for yt-dlp ordering, missing-key errors, and helper paths.
- Add live coverage for yt-dlp transcript mode and missing-caption YouTube pages.

### Dev

- Add `Dockerfile.test` for containerized yt-dlp testing.

## 0.2.0 - 2025-12-20

### Changes

- Add native OpenRouter support via `OPENROUTER_API_KEY`.
- Remove map-reduce summarization; reject inputs that exceed the model's context window.
- Preflight text prompts with the GPT tokenizer and the model’s max input tokens.
- Reject text files over 10 MB before tokenization.
- Reject too-small numeric `--length` and `--max-output-tokens` values.
- Cap summaries to the extracted content length when a requested size is larger.
- Skip summarization for tweets when extracted content is already below the requested length.
- Use bird CLI for tweet extraction when available and surface it in the status line.
- Fall back to Nitter for tweet extraction when bird fails; report a clear error when tweet data is unavailable.
- Compute cost totals via tokentally’s tally helpers.
- Improve fetch spinner with elapsed time and throughput updates.
- Show Firecrawl fallback status and reason when scraping kicks in.
- Enforce a hard deadline for stalled streaming LLM responses.
- Merge cumulative streaming chunks correctly and keep stream-merge for streaming output.
- Fall back to non-streaming when streaming requests time out.
- Preserve parentheses in URL paths when resolving inputs.
- Stop forcing Firecrawl for --extract-only; only use it as a fallback.
- Avoid Firecrawl fallback when block keywords only appear in scripts/styles.

### Tests

- Add CLI + live coverage for prompt length capping.
- Add coverage for cumulative stream merge handling.
- Add coverage for streaming timeout fallback.
- Add live coverage for Wikipedia URLs with parentheses.
- Add coverage for tweet summaries that bypass the LLM when short.
- Add coverage for content budget paths and TOKENTALLY cache dir overrides.

### Docs

- Update release checklist to all-in-one flow.
- Fix release script quoting.
- Document input limits and minimum length/token values.

### Dev

- Add a tokenization benchmark script.

### Fixes

- Preserve balanced parentheses/brackets in URL paths (e.g. Wikipedia titles).
- Avoid Firecrawl fallback when block keywords only appear in scripts/styles.
- Add a Bird install tip when Twitter/X fetch fails without bird installed.
- Graceful error when tweet extraction fails after bird + Nitter fallback.

## 0.1.1 - 2025-12-19

### Fixes

- Accept common “pasted URL” patterns like `url (canonical)` and clean up accidental `\\?` / `\\=` / `%5C` before query separators.

## 0.1.0 - 2025-12-19

First public release.

### CLI

- `summarize` CLI shipped via `@steipete/summarize` (plus optional library exports).
- Inputs: URL, local file path, or remote file URL (PDFs/images/audio/video/text).
- Automatic map-reduce for large inputs.
- Streaming output by default on TTY, with Markdown → ANSI rendering (via `markdansi`).
- Final “Finished in …” line: timing, token usage, cost estimate (when pricing is available), and service counts.
- Flags:
  - `--model <provider/model>` (default `google/gemini-3-flash-preview`)
  - `--length short|medium|long|xl|xxl|<chars>` (guideline; no hard truncation)
  - `--max-output-tokens <count>` (optional hard cap)
  - `--timeout <duration>` (default `2m`)
  - `--stream auto|on|off`, `--render auto|md|plain`
  - `--extract` (URLs only; no summary)
  - `--json` (structured output incl. input config, prompt, extracted content, LLM metadata, and metrics)
  - `--metrics off|on|detailed` (default `on`)
  - `--verbose`

### Sources

- Websites: fetch + extract “article-ish” content + normalization for prompts.
- Firecrawl fallback for blocked/thin sites (`--firecrawl off|auto|always`, via `FIRECRAWL_API_KEY`).
- Markdown extraction for websites in `--extract` mode (`--format md|text`, `--markdown-mode off|auto|llm`).
- YouTube (`--youtube auto|web|apify`):
  - best-effort transcript endpoints
  - optional Apify fallback (requires `APIFY_API_TOKEN`; single actor `faVsWy9VTSNVIhWpR`)
- Files (remote or local): MIME sniffing + best-effort forwarding to the model.
  - text-like inputs are inlined for provider compatibility

### LLM providers

- Direct-provider API keys (no gateway).
- OpenAI-compatible base URL support (`OPENAI_BASE_URL`, `OPENROUTER_API_KEY`).
- Model ids: `openai/...`, `anthropic/...`, `xai/...`, `google/...`.
- Auto-handling of provider/model limitations (e.g. no streaming support → non-streaming call; unsupported media types → friendly error).

### Pricing + limits

- Token/cost estimates and model limits derived from LiteLLM’s model catalog, downloaded + cached under `~/.summarize/cache/`.

### Quality

- CI: lint, tests (coverage), and pack.
- Tooling: Biome (lint/format) + Vitest (tests + coverage gate).
