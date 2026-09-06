---
title: "Slides"
kicker: "modes"
summary: "Slide extraction, model summaries, and transcript/OCR fallbacks in the CLI and browser."
read_when:
  - "When changing slide summaries, slide UI, or slide/seek behavior in the side panel."
---

# Slides

Slides mode pairs video keyframes with timestamped text. Extraction itself does not require a model; summaries can use the configured provider or on-device Gemini Nano. Sources include YouTube URLs, direct video URLs, and local video files.

## CLI

- `summarize <source> --slides` streams a short intro paragraph and then a continuous narrative with slide images inserted inline where `[slide:N]` markers appear. The source can be a YouTube URL, direct video URL, or local video file.
  - The model is responsible for inserting every slide marker in order; text length is still governed by `--length`.
  - If inline images are unsupported, the CLI prints text-only output and notes how to export slides to disk.
  - Timestamp links use OSC-8 when supported (YouTube/Vimeo/Loom/Dropbox).
  - Progress line reports slide extraction steps (includes slide counts when available).
- `summarize <source> --slides --extract` prints the full timed transcript and inserts slide images inline at matching timestamps.
- `summarize slides <source>` extracts slides without summarizing (use `--render auto|kitty|iterm` for inline thumbnails).
- Defaults to writing images under `./slides/<sourceId>/` (override via `--slides-dir` / `--output`).

See [the slides command](commands/slides.md) for extraction flags and requirements.

## Browser side panel

Slide mode shows vertical image/timestamp/text cards instead of the large summary block. Text can appear before extraction finishes, and cards remain visible without descriptions. Clicking a slide seeks the video, without opening a modal.

Generated slide summaries take precedence over transcript fallbacks. Gemini Nano can generate slide summaries locally using transcript context and available images; it falls back to text-only or smaller requests when needed. Other models use the configured summary runtime. Transcript windows supply missing descriptions, with enabled OCR as a fallback when no transcript is available. Selecting OCR mode prefers recognized text; the toggle appears only when enabled OCR has enough meaningful text.

Fallback text budgets scale with `--length`: approximately 120/200/320/480/700 characters for `short`/`medium`/`long`/`xl`/`xxl`. Custom character targets are divided across at most ten slides and clamped to 80–900 characters per slide. Transcript windows grow from 30 to 180 seconds, stop at the next slide, and include a short lead-in. These are fallback-text budgets, not limits on model-generated summaries.

Browser extraction uses MediaBunny/WebCodecs for fetchable videos and visible-tab capture as a fallback. Daemon extraction uses downloaded media with FFmpeg and optional Tesseract OCR. See [browser settings](chrome-extension.md) for runtime selection.

## Ownership

Core owns transcript parsing, fallback budgets, and slide-summary coercion. The side panel owns description selection and rendering state; browser AI owns on-device model sessions. CLI output owns terminal rendering and image support.

Daemon/CLI extraction downloads media once for detection and frame extraction, reusing cached media when available. `SLIDES_EXTRACT_STREAM=1` permits lower-accuracy stream fallback after download failure. Failed downloads and failed cache handoffs clean their temporary files; successful handoffs return cleanup to the extraction caller. See [the rendering flow](slides-rendering-flow.md) for implementation entrypoints.
