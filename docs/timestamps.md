---
title: "Timestamps"
kicker: "modes"
summary: "Transcript timestamps plan + clickable chat jumps."
read_when:
  - "When planning transcript timestamps or click-to-seek UX."
---

# Transcript Timestamps Plan

Short scope

- Add `--timestamps` flag to request timed transcripts.
- Preserve existing plain transcript text; add structured segments + timed text.
- Chat mode: include timed transcript + prompt for `[mm:ss]` references.
- Sidepanel: click timestamp → seek media (video or audio), keep play state.
- Coverage: YouTube, podcasts, embedded captions, generic media; whisper.cpp = no segments unless we add verbose output later.

## 1) API / data model

- New option: `FetchLinkContentOptions.transcriptTimestamps?: boolean`.
- Thread through provider options (`ProviderFetchOptions`).
- New types:
  - `TranscriptSegment`: `{ startMs: number; endMs?: number | null; text: string }`.
  - `TranscriptResolution.segments?: TranscriptSegment[] | null`.
  - `ExtractedLinkContent.transcriptSegments?: TranscriptSegment[] | null`.
  - `ExtractedLinkContent.transcriptTimedText?: string | null` (helper).
- Keep `TranscriptResolution.text` unchanged (plain transcript).

Notes

- `--timestamps` should only alter output when requested; default output remains stable.
- For JSON output, include both `transcriptSegments` and `transcriptTimedText` when requested.

## 2) Provider updates

YouTube (youtubei)

- Parse `startMs` (and duration if present) from `transcriptSegmentRenderer`.
- Build segments array; `text` still plain (join of text).

YouTube (captionTracks json3 / xml)

- json3 provides `events[].tStartMs` and `dDurationMs`; parse segments from `events.segs[].utf8`.
- XML captions include `start` + `dur`; parse segments when present.

Podcast RSS transcripts

- VTT parser should output segments (start/end + cue text).
- JSON transcript: support `segments` with `start`/`startMs` + `end`/`endMs` + `text`.
- Plain text transcripts: `segments = null`.

Generic embedded captions

- When track is VTT/JSON, parse into segments; otherwise `null`.

yt-dlp / whisper / whisper.cpp

- Keep `segments = null` (plain text only).
- Optional future: request verbose or SRT output from OpenAI/FAL when supported.

## 3) Cache behavior

- Store `segments` in transcript metadata (or dedicated cache field).
- If `--timestamps` and cached transcript lacks segments, treat as miss and refetch.
- Keep cache keys stable; only bypass when timestamps requested.

## 4) CLI / daemon

- Add `--timestamps` to CLI help + config.
- Map to `FetchLinkContentOptions.transcriptTimestamps`.
- `--extract --json`: include `transcriptSegments` + `transcriptTimedText`.
- Non-JSON extract: keep plain transcript unless `--timestamps`, then output timed text block.

## 5) Chat prompt + content

- `buildChatPageContent`: when timestamps requested, include `Timed transcript:` block using `[mm:ss]`.
- `buildChatSystemPrompt`: add instruction:
  - “When referencing moments, include `[mm:ss]` timestamps from the transcript.”

## 6) Chrome extension UI

Render

- Linkify `[mm:ss]` and `[hh:mm:ss]` in assistant messages.
- Convert to `timestamp:<seconds>` hrefs (or data attribute).

Seek handler

- On click: prevent default, parse seconds, send `panel:seek` → background → content script.
- Content script:
  - Find `<video>` or `<audio>`.
  - Record `wasPaused = media.paused`.
  - `media.currentTime = seconds`.
  - If `!wasPaused`, call `media.play()`; else do nothing.
- YouTube fallback when no media element:
  - If `window.ytplayer` / YT IFrame API available, `player.seekTo(seconds, true)`.

## 7) Tests

Core

- youtubei transcript parsing yields segments + plain text.
- captionTracks json3 + xml yield segments.
- VTT parser yields segments.
- Cache: timestamps requested + cached without segments → refetch.

Daemon / CLI

- `--timestamps` propagates into fetch options.
- JSON extract includes `transcriptSegments` + `transcriptTimedText`.

Chrome extension

- Chat content includes timed transcript when requested.
- Sidepanel: timestamp link emits `panel:seek`.
- Content script seek: playing stays playing, paused stays paused; audio + video.

## 8) Changelog

- Entry: `--timestamps` flag, timed transcripts in chat, clickable timestamps in extension, podcast support.

## 9) Notes / open

- “VisPoR” = whisper.cpp: no timestamps unless we add verbose output path.
- Decide exact format of `transcriptTimedText` (recommend `[mm:ss] text` per line).
