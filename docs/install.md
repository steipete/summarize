---
title: Install
kicker: get started
summary: "Install the summarize CLI and optional media dependencies."
---

# Install

`summarize` ships as a single npm package and a Homebrew formula. The CLI works on its own; the Chrome Side Panel needs the local daemon (covered in [Chrome extension](chrome-extension.md)).

## Requirements

- Node **24 or newer**.
- macOS, Linux, or Windows. Containers work too — see [Notes](#notes-windows-containers) below.
- Optional: `ffmpeg`, `yt-dlp`, `tesseract` for media-heavy features.

## CLI

### npm (cross-platform)

```bash
npm i -g @steipete/summarize
```

### Homebrew (macOS, Linux)

```bash
brew install summarize
```

The Homebrew formula lives in `homebrew/core`. If Homebrew isn't available, use the npm route.

### npx (no install)

```bash
npx -y @steipete/summarize "https://example.com"
```

Useful for one-shot summaries on a fresh machine.

### Library use

If you want extraction without the CLI, install the trimmed library:

```bash
npm i @steipete/summarize-core
```

```ts
import { createLinkPreviewClient } from "@steipete/summarize-core/content";
```

## Optional dependencies

These unlock media features but are not required for plain web pages.

| Tool                           | Required for                                                             |
| ------------------------------ | ------------------------------------------------------------------------ |
| `ffmpeg`                       | `--slides` extraction; many local media + transcription flows            |
| `yt-dlp`                       | YouTube slide extraction and some remote media flows                     |
| `tesseract`                    | OCR text on extracted slides via `--slides-ocr`                          |
| `whisper.cpp` (binary on PATH) | Local audio transcription fallback (preferred over cloud when available) |

### macOS

```bash
brew install ffmpeg yt-dlp
brew install tesseract        # optional, for --slides-ocr
brew install whisper-cpp      # optional, local Whisper
```

### Linux

```bash
sudo apt install ffmpeg yt-dlp tesseract-ocr
# whisper.cpp: build from source or fetch a binary release
```

### Optional cloud transcription

Set any of these env vars to enable a cloud transcription path. `summarize` picks one automatically (Groq is preferred for speed when available).

```bash
export GROQ_API_KEY=...
export ASSEMBLYAI_API_KEY=...
export GEMINI_API_KEY=...
export OPENAI_API_KEY=...
export FAL_KEY=...
```

If `--slides` is enabled and `ffmpeg`/`yt-dlp` are missing, summarize logs a warning and continues without slides — it never fails the run.

## Provider keys

Set the keys for the providers you want to use. Most flows work with at least one; missing keys only block their respective `--model` namespaces.

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=...
export GEMINI_API_KEY=...
export XAI_API_KEY=xai-...
export NVIDIA_API_KEY=nvapi-...
export OPENROUTER_API_KEY=or-...
export Z_AI_API_KEY=...
export GITHUB_TOKEN=ghp-...   # for github-copilot/* models
```

Full list and routing details: [LLM overview](llm.md). For free OpenRouter models, run `summarize refresh-free` once after setting `OPENROUTER_API_KEY`.

## Verify the install

```bash
summarize --version
summarize "https://en.wikipedia.org/wiki/Llama" --extract --format md | head
```

## Local docs preview

The docs are a Jekyll site under `docs/`. Preview them locally with:

```bash
bundle exec jekyll serve -s docs --port 4000
# or, from the repo root:
./scripts/docs-serve.sh
```

The first run installs the Ruby gems listed in `docs/Gemfile` (you may need `bundle install` first).

## Notes (Windows / containers)

- **Windows native:** `summarize` runs under Node 24. The daemon registers a Scheduled Task on first install.
- **Windows containers:** `summarize daemon install` starts the daemon for the current container session but does not register a Scheduled Task. Run the install on each startup or add it to the container entrypoint, and publish port `8787` so a host browser can reach the daemon.
- **WSL2:** treat as Linux. The daemon installs as a systemd user service if `systemd` is available; otherwise run `summarize daemon run` in a long-lived shell.

Next: head to [Quickstart](quickstart.md).
