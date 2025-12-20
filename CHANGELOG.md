# Changelog

## 0.3.0 - 2025-12-20

### Changes

- Add yt-dlp audio transcription fallback for YouTube; prefer OpenAI Whisper with FAL fallback. Thanks @dougvk.
- Add `--no-playlist` to yt-dlp downloads to avoid transcript mismatches.
- Run yt-dlp after web + Apify in `--youtube auto`, and error early for missing keys in `--youtube yt-dlp`.
- Require Node 22+.
- Respect `OPENAI_BASE_URL` when set, even with OpenRouter keys.
- Apply OpenRouter provider ordering headers to HTML→Markdown conversion.
- Add OpenRouter configuration tests. Thanks @dougvk for the initial OpenRouter support.
- Build and ship a Bun bytecode arm64 binary for Homebrew.

### Tests

- Add coverage for yt-dlp ordering, missing-key errors, and helper paths.
- Add live coverage for yt-dlp transcript mode and missing-caption YouTube pages.

### Dev

- Add `Dockerfile.test` for containerized yt-dlp testing.

## 0.2.0 - 2025-12-20

### Changes

- Add native OpenRouter support via `OPENROUTER_API_KEY` with optional provider ordering (`OPENROUTER_PROVIDERS`).
- Add `--model auto` for context-aware model selection via OpenRouter (smaller inputs use cheaper models).
  - Configurable via `OPENROUTER_MODEL_SMALL`, `OPENROUTER_MODEL_LARGE`, `OPENROUTER_THRESHOLD_*`, `OPENROUTER_PROVIDERS_*`
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
  - `--stream auto|on|off`, `--render auto|md-live|md|plain`
  - `--extract-only` (URLs only; no summary)
  - `--json` (structured output incl. input config, prompt, extracted content, LLM metadata, and metrics)
  - `--metrics off|on|detailed` (default `on`)
  - `--verbose`

### Sources

- Websites: fetch + extract “article-ish” content + normalization for prompts.
- Firecrawl fallback for blocked/thin sites (`--firecrawl off|auto|always`, via `FIRECRAWL_API_KEY`).
- Markdown extraction for websites in `--extract-only` mode (`--markdown off|auto|llm`).
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
