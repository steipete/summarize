---
title: "Media + podcasts"
kicker: "modes"
summary: "Embedded media detection + transcript-first pipeline."
read_when:
  - "When changing media detection, embedded captions, or video-mode behavior."
---

# Media detection + transcript-first

## Detection (HTML)

- Embedded video/audio: `<video>` / `<audio>` tags, `og:video` / `og:audio`, iframe embeds (YouTube/Vimeo/Twitch/Wistia, Spotify/SoundCloud/Podcasts).
- Captions: `<track kind="captions|subtitles" src=...>`.

## Transcript resolution order

1. Embedded captions (VTT/JSON) when available.
2. yt-dlp download + transcription (Groq first; then ONNX/local whisper.cpp; then AssemblyAI/Gemini/OpenAI/FAL fallback).

## CLI behavior

- `--video-mode transcript` prefers transcript-first media handling even when a page has text.
- Direct media URLs (mp4/webm/m4a/etc) skip HTML and transcribe.
- Local audio/video files are routed through the same transcript-first pipeline.
- YouTube still uses the YouTube transcript pipeline (captions → yt-dlp fallback).
- X/Twitter status URLs with detected video auto-switch to transcript-first (yt-dlp), even in auto mode.
- X broadcasts (`/i/broadcasts/...`) are treated as media-only and go transcript-first by default.
- Local media files are capped at 2 GB; remote media URLs are best-effort via yt-dlp (no explicit size limit).
- Remote transcription providers: `ASSEMBLYAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `FAL_KEY` (plus `GROQ_API_KEY` before local/remote fallback).
- Gemini uses the Files API automatically for larger uploads.

## Shared helpers

- Direct media classification lives in `packages/core/src/content/direct-media.ts`.
- Local path/`file://` normalization + mtime lookup lives in `packages/core/src/content/local-file.ts`.
- Slides, URL extraction, and transcription should reuse those helpers instead of re-parsing extensions separately.

## Chrome extension behavior

- When media is detected on a page, the Summarize button gains a dropdown caret (Page/Video or Page/Audio).
- Selecting Video/Audio forces URL mode + transcript-first extraction for that run only.
- Selection is not stored.

## Known limits

- No auth/cookie handling for embedded media; login-gated assets will fail.
- Captions are best-effort; if captions are missing or unreadable, we fall back to transcription.
