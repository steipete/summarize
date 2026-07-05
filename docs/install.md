---
title: Install
kicker: get started
summary: "Install the summarize CLI and optional media dependencies."
---

# Install

`summarize` ships as a single npm package and a Homebrew formula. The CLI works on its own. Chrome Browser mode also works without the local daemon; the daemon adds faster and broader media support.

## Requirements

- Node **24 or newer**.
- macOS, Linux, or Windows. Containers work too — see [Notes](#notes-windows-containers) below.
- Optional: native `ffmpeg`, `yt-dlp`, `tesseract` for expanded media support.

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

| Tool                           | Required for                                                              |
| ------------------------------ | ------------------------------------------------------------------------- |
| `ffmpeg`                       | Faster extraction/transcoding and broader codecs than bundled WebAssembly |
| `yt-dlp`                       | YouTube slide extraction and some remote media flows                      |
| `tesseract`                    | OCR text on extracted slides via `--slides-ocr`                           |
| `whisper.cpp` (binary on PATH) | Local audio transcription fallback after Groq and before other cloud APIs |

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
export DEEPGRAM_API_KEY=...
```

If native `ffmpeg`/`ffprobe` are missing, summarize falls back to its bundled LGPL FFmpeg WebAssembly build. Native ffmpeg remains recommended for speed and broader codec/filter support. Automatic YouTube transcription can resolve Android VR direct audio without `yt-dlp`; explicit `--youtube yt-dlp`, diarization, and some slide/media flows still require it.

Set `SUMMARIZE_DISABLE_FFMPEG_WASM=1` to disable the bundled fallback.

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

## Local Docs Preview

Build and preview the static docs site from the repo root with:

```bash
./scripts/docs-serve.sh
```

Use `PORT=4001 ./scripts/docs-serve.sh` to pick another port.

## Notes (Windows / containers)

- **Windows native:** `summarize` runs under Node 24. The daemon registers a Scheduled Task on first install.
- **Windows containers:** `summarize daemon install` starts the daemon for the current container session but does not register a Scheduled Task. Chrome Daemon mode also needs the pending packaged Windows native-host executable; Direct and Browser modes remain available.
- **WSL2:** treat as Linux. The daemon installs as a systemd user service if `systemd` is available; otherwise run `summarize daemon run` in a long-lived shell.

Next: head to [Quickstart](quickstart.md).
