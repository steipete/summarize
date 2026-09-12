---
title: summarize slides
permalink: /docs/commands/slides.html
kicker: command
summary: "Extract scene-change keyframes from a video source into PNG files."
---

# `summarize slides`

```text
summarize slides <source> [flags]
```

Extracts slide-shaped keyframes from a YouTube URL, direct video URL, or local video file using FFmpeg scene detection. Native ffmpeg is preferred; bundled FFmpeg WebAssembly is used when native `ffmpeg`/`ffprobe` are unavailable. Output is a directory of PNGs (and optional OCR text). This is the standalone form of the `--slides` flag on the main command — useful when you only want the slides without a summary.

## Synopsis

```bash
summarize slides "https://youtu.be/..."
summarize slides "https://youtu.be/..." --render auto
summarize slides "https://youtu.be/..." --slides-ocr -o ./out
summarize slides "https://example.com/lecture.mp4" --slides-max 12
summarize slides ./lecture.mp4 --slides-max 12
```

## Requirements

- Bundled FFmpeg WebAssembly, or native `ffmpeg` on PATH for faster extraction and broader codec support.
- `yt-dlp` on PATH for YouTube URLs.
- `tesseract` on PATH for `--slides-ocr`.

If a required tool is missing, summarize prints a clear warning and exits non-zero.

## Flags

`--slides-ocr`
: Run OCR on every extracted slide. Stores `ocrText` and `ocrConfidence` in `slides.json` and the JSON response.

`--slides-dir <dir>`
: Output base directory. Default: `./slides`. A per-video subfolder is created inside.

`-o, --output <dir>`
: Alias for `--slides-dir`.

`--slides-scene-threshold <value>`
: Scene detection threshold, `0.1`–`1.0`. Default `0.3`. Lower values detect more scenes (more slides); higher values are stricter.

`--slides-max <count>`
: Cap on extracted slides. Default `6`.

`--slides-min-duration <seconds>`
: Minimum gap between slides. Default `2`.

`--render <mode>`
: Inline render of thumbnails: `auto`, `kitty`, `iterm`, `none`. Default `none` — paths are printed instead.

`--theme <name>`
: Pick a CLI theme.

`--timeout <duration>`
: Per-operation timeout setting. Default `2m`; not an overall wall-clock deadline. yt-dlp downloads and FFmpeg scene detection allow at least `5m`, and individual extraction/probe steps have their own limits.

`--no-cache`
: Force re-download and re-extraction (bypasses both caches).

`--json`
: JSON envelope on stdout. Disables inline rendering.

`--verbose` / `--debug`
: Detailed progress on stderr.

`-V`, `--version`
: Print version and exit.

## Output

Each run writes a directory like:

```text
slides/<source-id>/
  slide_0001_18.60s.png
  slide_0002_42.20s.png
  ...
  slides.json
```

The filenames include the slide index and timestamp. `slides.json` records the manifest, including OCR results when requested; OCR does not create separate text files. `ocrConfidence` uses a 0–1 scale.

In `--json` mode, stdout contains an envelope like this (additional extraction metadata omitted):

```json
{
  "ok": true,
  "slides": {
    "sourceUrl": "https://example.com/lecture.mp4",
    "slidesDir": "/absolute/path/slides/<id>",
    "slides": [
      {
        "index": 1,
        "timestamp": 18.6,
        "imagePath": "/absolute/path/slides/<id>/slide_0001_18.60s.png",
        "ocrText": "Recognized slide text",
        "ocrConfidence": 0.92
      }
    ]
  }
}
```

## Inline rendering

`--render auto` detects Kitty (`KITTY_WINDOW_ID`) and iTerm (`TERM_PROGRAM=iTerm.app`) and uses the matching image protocol. On unsupported terminals, slides are listed by path instead.

## Examples

```bash
# Quick preview in iTerm/Kitty.
summarize slides "https://youtu.be/..." --render auto

# Big lecture, more granular cuts.
summarize slides "https://youtu.be/..." \
  --slides-max 24 --slides-scene-threshold 0.2

# Pipe-friendly JSON for an automation.
summarize slides "https://youtu.be/..." --json | jq '.slides.slides[].imagePath'

# Force re-extraction after editing the source video.
summarize slides "./talk.mp4" --no-cache -o ./out
```

## See also

- [Slides mode](../slides.md) — the inline `--slides` flag on the main command.
- [Slides rendering flow](../slides-rendering-flow.md) — pipeline internals.
