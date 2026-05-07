---
title: Overview
permalink: /docs/
kicker: docs
summary: "summarize is a fast CLI and Chrome Side Panel for clean extraction and sharp summaries of web pages, files, YouTube videos, and podcasts."
---

# summarize

`summarize` turns a URL, file, or piped text into a sharp summary. It runs a real extraction pipeline first — Readability, Firecrawl, transcript fetchers, Whisper — then hands clean content to the model of your choice. Local, paid, and free models all work.

## Try it

```bash
# Summarize a web page (auto-extract, default model).
summarize "https://example.com/article"

# YouTube video — pulls transcripts; falls back to yt-dlp + Whisper.
summarize "https://youtu.be/I845O57ZSy4"

# Local file (PDF, image, audio, video) with an explicit model.
summarize ./report.pdf --model openai/gpt-5-mini

# Stop after extraction — perfect for pipes.
summarize "https://example.com" --extract --format md | wc -w

# Read from a clipboard or stdin.
pbpaste | summarize -

# Stream JSON for scripts (prompt + metrics included).
summarize "https://example.com" --json --metrics detailed
```

`--extract` skips the LLM entirely and prints the cleaned content. `--json` produces a stable envelope on stdout while progress, prompts, and warnings always go to stderr — pipes stay parseable.

## What summarize does

- **Real extraction.** Readability for articles, `markitdown` for files, Firecrawl as fallback when sites fight back.
- **Media-aware.** YouTube and podcast pages prefer published transcripts, then yt-dlp + Whisper, then optional ONNX models (Parakeet/Canary).
- **Provider-agnostic models.** xAI, OpenAI, Google, Anthropic, NVIDIA, Z.AI, OpenRouter, GitHub Copilot, plus local CLI providers (Claude Code, Codex, Gemini, Cursor Agent, OpenClaw, OpenCode, Copilot CLI).
- **Shaped output.** Streamed ANSI Markdown for terminals, plain text for pipes, JSON envelope for scripts, ANSI-stripped for `--no-color`.
- **Slides for video.** `--slides` extracts scene-change keyframes from videos and renders them inline (Kitty / iTerm) or saves them to disk.
- **Stays local where it matters.** Optional daemon + Chrome Side Panel pair the CLI with the active tab; the daemon is localhost-only and token-protected.

## Pick your path

- **Trying it for the first time.** [Install](install.md) → [Quickstart](quickstart.md). Five minutes from `npm i -g` to your first summary.
- **Looking up a flag.** [Commands](commands/) lists every subcommand and every flag with examples.
- **Wiring up a model.** [LLM overview](llm.md) explains the `--model` syntax, env vars, and provider routing. [Auto selection](model-auto.md) covers how `--model auto` picks one for you.
- **Pulling content from a stubborn site.** [Website mode](website.md) and [Firecrawl](firecrawl.md) cover extractor selection and fallbacks.
- **Working with video or audio.** [YouTube](youtube.md), [Media + podcasts](media.md), and [Slides](slides.md). Local transcription is in [ONNX transcription](nvidia-onnx-transcription.md).
- **Running the Chrome Side Panel.** [Chrome extension](chrome-extension.md) walks through pairing with the local daemon.

## Configuration

Put defaults in `~/.summarize/config.json` and override per-invocation with flags. The [Config reference](config.md) shows the full schema; the [LLM overview](llm.md) lists the env vars that gate each provider.

```json
{
  "model": "auto",
  "output": {
    "length": "xl",
    "language": "auto"
  },
  "models": {
    "free": ["openai/gpt-oss-120b:free", "z-ai/glm-4.6:free"]
  }
}
```

## Project

Active development; the [changelog](https://github.com/steipete/summarize/blob/main/CHANGELOG.md) tracks recent releases. Released under the [MIT license](https://github.com/steipete/summarize/blob/main/LICENSE). Source at [github.com/steipete/summarize](https://github.com/steipete/summarize).
