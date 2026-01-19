---
summary: "Website extraction pipeline, flags, and fallbacks."
read_when:
  - "When changing website extraction behavior."
---

# Website mode

Use this for non-YouTube URLs.

## What it does

- Fetches the page HTML.
- Extracts “article-ish” content and normalizes it into clean text.
- If extraction looks blocked or too thin, it can retry via Firecrawl (Markdown).
- If a page is effectively “video-only”, it may treat it as a video input (see `--video-mode`).
- `--video-mode transcript` prefers embedded media transcripts on pages with audio/video (captions → yt-dlp/Whisper fallback).
- With `--format md`, the CLI defaults to `--markdown-mode readability` (Readability article HTML as the Markdown input).
  - Use `--firecrawl always` to try Firecrawl first.
- With `--format md`, `--markdown-mode auto|llm|readability` can also convert HTML → Markdown via an LLM using the configured `--model` (no provider fallback).
- With `--format md`, `--markdown-mode auto` may fall back to `uvx markitdown` when available (disable with `--preprocess off`).
- For podcast URLs (Apple Podcasts, RSS, Spotify episodes), it downloads the episode audio and transcribes via Whisper (prefers local `whisper.cpp` when installed + model available); progress shows “Downloading audio …” then “Transcribing …” (duration uses RSS hints or `ffprobe` when available).
 
Daemon note:
- `/v1/summarize` accepts `format: "markdown"` plus `markdownMode`/`preprocess` to return extracted Markdown (especially when `extractOnly: true`).

## Twitter/X

- Short tweets skip the LLM when the requested summary length would exceed the tweet length; the tweet text is returned as-is.
- Tweet audio transcription runs only with `--video-mode transcript` (auto mode skips yt-dlp for tweets).

## Flags

- `--firecrawl off|auto|always`
- `--format md|text` (default: `text`)
- `--language, --lang <language>` (default: `auto`; match source language)
- `--markdown-mode off|auto|llm|readability` (default: `readability`; only affects `--format md` for non-YouTube URLs)
- `--preprocess off|auto|always` (default: `auto`; controls markitdown usage; `always` only affects file inputs)
- `--video-mode auto|transcript|understand` (only affects video inputs / video-only pages)
- Plain-text mode: use `--format text`.
- `--timeout 30s|30|2m|5000ms` (default: `2m`)
- `--extract` (print extracted content; no summary LLM call)
- `--json` (emit a single JSON object)
- `--verbose` (progress + which extractor was used)
- `--metrics off|on|detailed` (default: `on`; `detailed` adds a compact 2nd-line breakdown on stderr)

## API keys

- Optional: `FIRECRAWL_API_KEY` (for Firecrawl fallback / `--firecrawl always`)
- Optional: `XAI_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` (also accepts `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY`) (required only when `--markdown-mode llm` is used, or when `--markdown-mode auto` falls back to LLM conversion)
