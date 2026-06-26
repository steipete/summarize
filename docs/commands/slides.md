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
: Run OCR on every extracted slide. Saves a `.txt` next to each PNG.

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
: Cap the download + extraction. Default `2m`.

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
slides/<video-id>/
  001.png
  002.png
  ...
  001.txt    # only with --slides-ocr
```

In `--json` mode, stdout is:

```json
{
  "url": "...",
  "outDir": "slides/<id>",
  "slides": [{ "index": 1, "path": "...001.png", "timeSeconds": 18.6, "ocr": "..." }]
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
summarize slides "https://youtu.be/..." --json | jq '.slides[].path'

# Force re-extraction after editing the source video.
summarize slides "./talk.mp4" --no-cache -o ./out
```

## See also

- [Slides mode](../slides.md) — the inline `--slides` flag on the main command.
- [Slides rendering flow](../slides-rendering-flow.md) — pipeline internals.
