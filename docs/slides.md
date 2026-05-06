---
title: "Slides"
kicker: "modes"
summary: "Plan for slide-first UX without model usage."
read_when:
  - "When changing slide summaries, slide UI, or slide/seek behavior in the side panel."
---

# Slides plan (no model)

## Goals

- Expanded slides view = full-width cards, top of summary.
- Click slide = seek video timestamp (no modal).
- Descriptions scale with length setting.
- Always show all slides (even if text missing).
- No model call for slide descriptions.

## Data sources

- Primary: transcript timed text (already available with timestamps).
- Secondary: OCR text from slides (truncate, selectable).
- Tertiary: empty description (still render card).

## Description generation (no model)

- For each slide timestamp `t`:
  - Pull transcript segments within a time window around `t`.
  - Concatenate into plain text (no bullets).
  - If no transcript: use OCR text (trim).
  - If neither: empty string.
- Always render all slide cards; missing text → show slide only.

## Length scaling

- Map summary length to per-slide target chars.
- Use existing length presets (short/medium/long/xl/xxl + custom):
  - `short`: ~120 chars/slide
  - `medium`: ~200 chars/slide
  - `long`: ~320 chars/slide
  - `xl`: ~480 chars/slide
  - `xxl`: ~700 chars/slide
  - custom: derive from maxCharacters (e.g. `maxChars / min(slideCount, 10)`, clamp).
- Clamp per-slide text: `[80, 900]` chars.
- Window size should expand with length (e.g. 20s → 90s).

## UI behavior

- Side panel slide mode is slide-first:
  - vertical full-width cards by default
  - thumbnail + timestamp + text
  - transcript/OCR text appears before slide images finish extracting
- No giant summary block under active slide cards.
- Slide click: seek only (no modal).
- OCR toggle appears near summarize control only when OCR is significant
  (enough slides + total OCR chars); otherwise hide it.

## CLI

- `summarize <url> --slides` streams a short intro paragraph and then a continuous narrative with slide images inserted inline where `[slide:N]` markers appear.
  - The model is responsible for inserting every slide marker in order; text length is still governed by `--length`.
  - If inline images are unsupported, the CLI prints text-only output and notes how to export slides to disk.
  - Timestamp links use OSC-8 when supported (YouTube/Vimeo/Loom/Dropbox).
  - Progress line reports slide extraction steps (includes slide counts when available).
- `summarize <url> --slides --extract` prints the full timed transcript and inserts slide images inline at matching timestamps.
- `summarize slides <url>` extracts slides without summarizing (use `--render auto|kitty|iterm` for inline thumbnails).
- Defaults to writing images under `./slides/<sourceId>/` (override via `--slides-dir` / `--output`).

## Implementation notes

- Build `slideDescriptions` map in panel:
  - Use `summary.timedText` when available.
  - Split transcript into segments with timestamps (already in payload).
- Store per-slide text on client (no daemon model calls).
- Ensure summary cache keys untouched; only client-only rendering.
- Slide extraction downloads the media once for detect+extract; set `SLIDES_EXTRACT_STREAM=1` to allow stream fallback (lower accuracy).

## Steps

1. Add slide-description builder in sidepanel using transcript timed text + OCR fallback.
2. Add length-based per-slide char budget and window sizing.
3. Render expanded card list with timestamps + text.
4. Remove modal; click = seek only.
5. Add tests for slide description + fallback.
