---
title: "Manual tests"
kicker: "project"
summary: "Manual end-to-end test checklist for model and input coverage."
read_when:
  - "When doing release validation."
---

# Manual tests

Goal: sanity-check auto selection + presets end-to-end.

## Setup

- `OPENAI_API_KEY=...` (optional)
- `ASSEMBLYAI_API_KEY=...` (optional)
- `GEMINI_API_KEY=...` (optional)
- `ANTHROPIC_API_KEY=...` (optional)
- `XAI_API_KEY=...` (optional)
- `OPENROUTER_API_KEY=...` (optional)
- `Z_AI_API_KEY=...` (optional)

Tip: use `--verbose` to see model attempts + the chosen model.

## Auto (default)

- Website summary (should pick a model, show it in spinner):
  - `summarize --max-output-tokens 200 https://example.com`
- No-model-needed shortcut (should print extracted text; no footer “no model needed”):
  - `summarize --max-output-tokens 99999 https://example.com`
- Missing-key skip (configure only one key; should skip other providers, still succeed):
  - Set only `OPENAI_API_KEY`, then run a website summary; should not try Gemini/Anthropic/XAI.
- AssemblyAI transcript path:
  - Set only `ASSEMBLYAI_API_KEY`, then run a podcast URL or `--youtube yt-dlp` flow; `transcriptionProvider` should report `assemblyai`.
- Podcast URL (Whisper): should show “Downloading audio …” then “Transcribing …” with duration when known.
  - `summarize https://podcasts.apple.com/us/podcast/2424-jelly-roll/id360084272?i=1000740717432 --metrics detailed`

## Presets

- Define a preset in `~/.summarize/config.json` (see `docs/config.md` → “Presets”), then:
  - `summarize --model <preset> --max-output-tokens 200 https://example.com`
  - If the preset contains OpenRouter models, ensure `OPENROUTER_API_KEY` is set.

## Images

- Local image (auto uses API models by default; enable CLI via `cli.enabled` to test CLIs):
  - `summarize ./path/to/image.png --max-output-tokens 200`

## Video

- YouTube:
  - `summarize https://www.youtube.com/watch?v=dQw4w9WgXcQ --max-output-tokens 200`
- YouTube summary w/ timestamps (expect `[mm:ss]` in output):
  - `summarize --timestamps --youtube web --length short https://www.youtube.com/watch?v=I845O57ZSy4`
- Local video understanding (requires Gemini video-capable model; otherwise expect an error or transcript-only behavior depending on input):
  - `summarize ./path/to/video.mp4 --max-output-tokens 200`

## Z.AI

- `summarize --model zai/glm-4.7 --max-output-tokens 200 https://example.com`
