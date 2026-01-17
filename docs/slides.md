---
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
- Default summary stays unchanged (no slide text).
- Slide strip (compact) stays horizontal; no modal required.
- Expand toggle switches to vertical full-width list:
  - cards: thumbnail, timestamp, text.
  - cards appear above summary.
- Slide click: seek only (no modal).
- OCR toggle appears near summarize control only when OCR is significant
  (enough slides + total OCR chars); otherwise hide it.

## CLI (slides-only)
- `summarize slides <url>` extracts slides without summarizing.
- `summarize <url> --slides` renders inline thumbnails automatically when supported.
- Defaults to writing images under `./slides/<sourceId>/` (override via `--slides-dir` / `--output`).
- Inline terminal rendering is opt-in: `--render auto|kitty|iterm` (Konsole uses the kitty protocol).

## Implementation notes
- Build `slideDescriptions` map in panel:
  - Use `summary.timedText` when available.
  - Split transcript into segments with timestamps (already in payload).
- Store per-slide text on client (no daemon model calls).
- Ensure summary cache keys untouched; only client-only rendering.
- Slide extraction downloads the media once for detect+extract; set `SLIDES_EXTRACT_STREAM=1` to allow stream fallback (lower accuracy).

## Steps
1) Add slide-description builder in sidepanel using transcript timed text + OCR fallback.
2) Add length-based per-slide char budget and window sizing.
3) Render expanded card list with timestamps + text.
4) Remove modal; click = seek only.
5) Add tests for slide description + fallback.
