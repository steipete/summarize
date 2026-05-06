---
title: Quickstart
kicker: get started
summary: "Five-minute path from install to first summary."
---

# Quickstart

You should already have `summarize` installed — if not, see [Install](install.md). This page goes from zero to a working summary in five minutes.

## 1. Set one provider key

`summarize --model auto` works as soon as one provider key is exported. Pick whichever you have:

```bash
export OPENAI_API_KEY=sk-...
# or
export GEMINI_API_KEY=...
# or — free models via OpenRouter
export OPENROUTER_API_KEY=...
summarize refresh-free   # picks working :free models
```

The full provider list is in [LLM overview](llm.md). To skip provider selection entirely, point at a CLI provider you already have logged in:

```bash
summarize "https://example.com" --cli claude
summarize "https://example.com" --cli codex
```

## 2. Your first summary

```bash
summarize "https://en.wikipedia.org/wiki/Llama"
```

You'll see streaming Markdown in the terminal. The default length is `xl` (~10k chars); use `--length` to change it:

```bash
summarize "https://example.com/long-article" --length short
summarize "https://example.com/long-article" --length 3k
summarize "https://example.com/long-article" --length 30000
```

## 3. YouTube and podcasts

```bash
summarize "https://youtu.be/I845O57ZSy4"
summarize "https://podcasts.apple.com/.../episode-..."
```

YouTube prefers official caption tracks, falls back through `youtubei` and Apify, and finally pulls audio with `yt-dlp` and transcribes with Whisper. Podcasts behave the same way: published transcript first, then `ffmpeg` + Whisper.

Add scene-change keyframes for video:

```bash
summarize "https://youtu.be/..." --slides
summarize "https://youtu.be/..." --slides --slides-ocr
```

## 4. Files and stdin

```bash
summarize ./report.pdf
summarize ./meeting.m4a
summarize ./diagram.png
pbpaste | summarize -
```

PDFs and images go through `markitdown` (or the Gemini/OpenAI vision path when configured). Audio + video files take the transcription path.

## 5. Extract without the LLM

When you only want clean text — for piping into another tool or saving to a file — use `--extract`:

```bash
summarize "https://example.com" --extract --format md > article.md
summarize "https://youtu.be/..." --extract --format md --markdown-mode llm
```

`--format md --markdown-mode llm` runs the model just enough to format the raw transcript into headings and paragraphs.

## 6. JSON for scripts

```bash
summarize "https://example.com" --json --metrics detailed
```

Returns a stable envelope with `summary`, `prompt`, `metrics`, and source metadata on stdout. Progress, prompts, and warnings always go to stderr.

## 7. Save defaults

Most flags have a config-file equivalent. Stash your preferences in `~/.summarize/config.json`:

```json
{
  "model": "auto",
  "output": {
    "length": "long",
    "language": "en"
  },
  "youtube": "auto",
  "firecrawl": "auto"
}
```

Now `summarize "https://example.com"` runs with those defaults; flags still override on the CLI. Full schema: [Config](config.md).

## What's next

- Browse every flag in [Commands → summarize](commands/summarize.md).
- Wire up a model: [LLM overview](llm.md), [Auto selection](model-auto.md), [OpenAI](openai.md).
- Stuck site? [Website mode](website.md), [Firecrawl](firecrawl.md).
- Pair with the browser: [Chrome extension](chrome-extension.md).
