---
title: summarize
permalink: /
kicker: cli + chrome side panel
hero: true
tagline: "Link → clean text → sharp summary."
description: "summarize is a fast CLI and Chrome Side Panel for clean extraction and sharp summaries of web pages, files, YouTube videos, and podcasts."
modes:
  - { color: "lime", label: "Website" }
  - { color: "orange", label: "YouTube" }
  - { color: "teal", label: "Podcasts" }
  - { color: "lime", label: "PDF / image" }
  - { color: "orange", label: "Audio / video" }
  - { color: "teal", label: "Slides" }
ctas:
  - { primary: true, label: "Quickstart", href: "/docs/quickstart.html" }
  - { label: "Install", href: "/docs/install.html" }
  - { label: "Commands", href: "/docs/commands/" }
---

`summarize` is a fast CLI for clean extraction and sharp summaries. It runs a real pipeline first — Readability for articles, `markitdown` for files, transcript fetchers and Whisper for media, Firecrawl as a fallback when sites fight back — then hands the result to whichever model you've wired up. Local, paid, and free models all work. A Chrome Side Panel pairs the CLI with the active tab.

## Try it

```bash
# Web page (default model, streamed Markdown).
summarize "https://example.com/article"

# YouTube — captions first, yt-dlp + Whisper as fallback.
summarize "https://youtu.be/I845O57ZSy4"

# Local file (PDF, image, audio, video).
summarize ./report.pdf --model openai/gpt-5-mini

# Stop after extraction — perfect for pipes.
summarize "https://example.com" --extract --format md | wc -w

# Clipboard / stdin.
pbpaste | summarize -

# JSON envelope for scripts (prompt + metrics included).
summarize "https://example.com" --json --metrics detailed
```

`--extract` skips the LLM and prints cleaned content. `--json` writes a stable envelope on stdout while progress, prompts, and warnings stay on stderr — pipes always parse cleanly.

## What summarize does

- **Real extraction.** Readability for articles, `markitdown` for files, Firecrawl as a fallback when sites fight back.
- **Media-aware.** YouTube and podcast pages prefer published transcripts, then `yt-dlp` + Whisper, then optional ONNX models (Parakeet/Canary).
- **Provider-agnostic models.** xAI, OpenAI, Google, Anthropic, NVIDIA, Z.AI, OpenRouter, GitHub Copilot, Ollama (local) — plus local CLI providers (Claude Code, Codex, Gemini, Cursor Agent, OpenClaw, OpenCode, Copilot CLI).
- **Shaped output.** Streamed ANSI Markdown for terminals, plain text for pipes, JSON envelope for scripts, ANSI-stripped under `--no-color`.
- **Slides for video.** `--slides` extracts scene-change keyframes and renders them inline (Kitty / iTerm) or saves them to disk.
- **Stays local.** Optional daemon + Chrome Side Panel pair the CLI with the active tab. The daemon binds to `127.0.0.1` only and uses a shared bearer token.

## Pick your path

- **Trying it for the first time.** [Install](docs/install.html) → [Quickstart](docs/quickstart.html). Five minutes from `npm i -g` to your first summary.
- **Looking up a flag.** [Commands](docs/commands/) — every subcommand and flag, with examples.
- **Wiring up a model.** [LLM overview](docs/llm.html), [Auto selection](docs/model-auto.html), [OpenAI options](docs/openai.html), [Ollama (local)](docs/ollama.html), [CLI providers](docs/cli.html).
- **Stuck site.** [Website mode](docs/website.html) and [Firecrawl](docs/firecrawl.html) cover extractor selection and fallbacks.
- **Audio / video work.** [YouTube](docs/youtube.html), [Media + podcasts](docs/media.html), [Slides](docs/slides.html), [ONNX transcription](docs/nvidia-onnx-transcription.html).
- **Browser pairing.** [Chrome extension](docs/chrome-extension.html) walks through pairing with the local daemon.
- **Defaults that stick.** [Config](docs/config.html) covers the JSON schema, env vars, presets, and provider base URLs.

## Configuration

Save defaults in `~/.summarize/config.json` and override per-invocation with flags. Full schema: [Config](docs/config.html).

```json
{
  "model": "auto",
  "output": {
    "length": "xl",
    "language": "auto"
  },
  "models": {
    "free": ["openai/gpt-oss-120b:free", "z-ai/glm-4.6:free"]
  },
  "cache": { "enabled": true, "maxMb": 512 }
}
```

## Project

Active development; the [changelog](https://github.com/steipete/summarize/blob/main/CHANGELOG.md) tracks recent releases. Released under the [MIT license](https://github.com/steipete/summarize/blob/main/LICENSE). Source at [github.com/steipete/summarize](https://github.com/steipete/summarize). The Chrome extension is on the [Chrome Web Store](https://chromewebstore.google.com/detail/summarize/cejgnmmhbbpdmjnfppjdfkocebngehfg).
