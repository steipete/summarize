---
title: summarize
permalink: /docs/commands/summarize.html
kicker: command
summary: "Main command. URL, file, or stdin → clean text → summary."
---

# `summarize`

```text
summarize [input] [flags]
```

Takes a URL, local file path, or `-` for stdin and produces a summary. With `--extract`, prints cleaned content instead of summarizing.

## Synopsis

```bash
summarize "https://example.com/article"
summarize ./report.pdf --model openai/gpt-5-mini
summarize "https://youtu.be/..." --slides --slides-ocr
pbpaste | summarize -
summarize "https://example.com" --extract --format md > clean.md
summarize "https://example.com" --json --metrics detailed
```

## Input

- **URL** — http/https. YouTube, podcast hosts, generic articles, raw media.
- **File path** — PDF, image, audio, video, plain text, Markdown, HTML.
- **`-`** — read content from stdin (text or binary).

If `[input]` is omitted, summarize prints concise help and exits.

## Flags

### Extraction

`--extract`
: Print extracted content and exit. No LLM call. The `--extract-only` alias is hidden but still works.

`--format <format>`
: `md` or `text`. Controls website extraction format and whether files are preprocessed to Markdown for model compatibility. Default: `text`. Default in `--extract` mode for URLs: `md`.

`--firecrawl <mode>`
: `off`, `auto`, `always`. `auto` falls back to Firecrawl when local extraction looks blocked or thin. Needs `FIRECRAWL_API_KEY`.

`--preprocess <mode>`
: `off`, `auto`, `always`. Default `auto`. Controls `markitdown` usage for files. `always` only affects file inputs.

`--markdown-mode <mode>`
: `off`, `auto`, `llm`, `readability`. For websites: HTML → Markdown strategy. For YouTube/transcripts: `llm` formats raw transcripts into clean Markdown with headings.

`--max-extract-characters <count>`
: Cap printed characters in `--extract` mode. Default: unlimited.

### YouTube / video

`--youtube <mode>`
: `auto`, `web`, `apify`, `yt-dlp`, `no-auto` (skip auto-generated captions). Default `auto`.

`--transcriber <name>`
: `auto`, `whisper`, `parakeet`, `canary`. Default `auto` — Groq when keyed, else local ONNX or `whisper.cpp`, then cloud fallbacks.

`--video-mode <mode>`
: `auto`, `transcript`, `understand`. `understand` prefers vision/video understanding when supported.

`--timestamps`
: Include timestamps in transcripts when available.

### Slides

`--slides [value]`
: Extract slides from a video URL and render inline alongside the summary. Combine with `--extract` to interleave slides in the full transcript. See [Slides mode](../slides.md).

`--slides-ocr`
: Run OCR on extracted slides. Requires `tesseract`.

`--slides-debug`
: Print slide image paths instead of rendering inline (useful in non-image terminals).

`--slides-dir <dir>`
: Output directory base. Default `./slides`.

`--slides-scene-threshold <value>`
: Scene detection threshold, `0.1`–`1.0`. Default `0.3`.

`--slides-max <count>`
: Cap on extracted slides. Default `6`.

`--slides-min-duration <seconds>`
: Minimum gap between slides. Default `2`.

### Summary control

`--length <length>`
: `short`, `medium`, `long`, `xl`, `xxl` (or `s`/`m`/`l`) or a character cap like `20000` or `20k`. Default `xl`. Override globally via `output.length` in [Config](../config.md).

`--force-summary`
: Always run the LLM, even when extracted content is shorter than the requested length.

`--language, --lang <language>`
: `auto`, `en`, `de`, `english`, `german`, … Default `auto` (matches source). Configurable via `output.language`.

`--prompt <text>` / `--prompt-file <path>`
: Override the summary prompt. Content is appended after the override.

### Models

`--model <model>`
: Model id. `auto`, `<config-preset>`, `cli/<provider>/<model>`, `xai/...`, `openai/...`, `nvidia/...`, `google/...`, `anthropic/...`, `zai/...`, `github-copilot/...`, or `openrouter/<author>/<slug>`. Default `auto`. See [LLM overview](../llm.md).

`--cli [provider]`
: Use a logged-in CLI provider: `claude`, `gemini`, `codex`, `agent`, `openclaw`, `opencode`. Equivalent to `--model cli/<provider>`. Without a value: enable CLI providers in auto-selection.

`--thinking <effort>`
: OpenAI reasoning effort. `none`, `low`, `medium`, `high`, `xhigh`. Aliases: `off`, `min`, `mid`. Only affects reasoning-capable OpenAI models.

`--service-tier <tier>`
: OpenAI service tier. `default`, `fast`, `priority`, `flex`. Maps to `service_tier` on the request.

`--fast`
: Shortcut for OpenAI `service_tier=priority`. Same effect as `--service-tier fast`.

`--max-output-tokens <count>`
: Hard cap for LLM output tokens. Accepts `2000`, `2k`. Overrides provider defaults.

`--retries <count>`
: LLM retry attempts on timeout. Default `1`.

### Output

`--json`
: Structured JSON envelope on stdout. Includes prompt + metrics. Disables streaming.

`--stream <mode>`
: `auto`, `on`, `off`. Default `auto` (TTY-only). Disabled in `--json` mode.

`--plain`
: Keep raw text/Markdown — no ANSI/OSC rendering.

`--no-color`
: Disable ANSI colors.

`--width <columns>`
: Override terminal width for Markdown rendering. Default: auto-detect, max 120.

`--theme <name>`
: Pick a CLI theme. Run `summarize --help` for the list. Env: `SUMMARIZE_THEME`.

### Cache

`--no-cache`
: Bypass the summary (LLM) cache. Media + transcript caches stay enabled.

`--no-media-cache`
: Disable the media download cache (`yt-dlp` outputs).

`--cache-stats`
: Print cache stats and exit.

`--clear-cache`
: Delete the cache database and exit.

See [Cache internals](../cache.md) for what's cached and where.

### Diagnostics

`--verbose`
: Detailed progress on stderr.

`--debug`
: Alias for `--verbose`. Also defaults `--metrics` to `detailed`.

`--metrics <mode>`
: `off`, `on`, `detailed`. Default `on`. Adds a compact second-line breakdown on stderr when `detailed`.

`--timeout <duration>`
: Cap the whole pipeline. `30`, `30s`, `2m`, `5000ms`. Default `2m`.

`-V`, `--version`
: Print version and exit.

## Examples

```bash
# Extracted plain text from a URL.
summarize "https://example.com" --extract

# Extracted Markdown — prefers Firecrawl when configured.
summarize "https://example.com" --extract --format md

# YouTube transcript as cleanly-formatted Markdown.
summarize "https://www.youtube.com/watch?v=..." \
  --extract --format md --markdown-mode llm

# Inline slides + summary.
summarize "https://www.youtube.com/watch?v=..." --slides

# Full transcript + inline slides.
summarize "https://www.youtube.com/watch?v=..." --slides --extract

# Hard caps + a specific model.
summarize "https://example.com" \
  --length 20k --max-output-tokens 2k --timeout 2m \
  --model openai/gpt-5-mini

# OpenAI fast tier with reasoning.
summarize "https://example.com" \
  --model openai/gpt-5.5 --fast --thinking medium

# GitHub Models via GITHUB_TOKEN.
summarize "https://example.com" --model github-copilot/gpt-5.4

# Config preset (alias defined in ~/.summarize/config.json).
summarize "https://example.com" --model mymodel

# Strict JSON for scripts.
summarize "https://example.com" --json --verbose

# Summarize the clipboard.
pbpaste | summarize -
```

## Environment

The provider keys and binary paths picked up at runtime are listed in [LLM overview](../llm.md#environment). `SUMMARIZE_MODEL` overrides the default model selection; `SUMMARIZE_THEME` picks the theme.

## See also

- [LLM overview](../llm.md) — how `--model` resolves to a provider.
- [Website mode](../website.md), [YouTube](../youtube.md), [Media + podcasts](../media.md).
- [Cache](../cache.md), [Firecrawl](../firecrawl.md).
- [Config](../config.md) for persistent defaults.
