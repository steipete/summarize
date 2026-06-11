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
3. YouTube only: Android VR direct audio + the same transcription chain when yt-dlp is missing or fails.

## CLI behavior

- `--video-mode transcript` prefers transcript-first media handling even when a page has text.
- Direct media URLs (mp4/webm/m4a/etc) skip HTML and transcribe.
- Local audio/video files are routed through the same transcript-first pipeline.
- YouTube still uses the YouTube transcript pipeline (captions → yt-dlp → Android VR direct audio fallback).
- X/Twitter status URLs with detected video auto-switch to transcript-first (yt-dlp), even in auto mode.
- X broadcasts (`/i/broadcasts/...`) are treated as media-only and go transcript-first by default.
- Local media files are capped at 2 GB. Remote podcast/media transcription downloads are capped at 512 MB by default and fail closed with `Remote media too large` even when the server omits or under-reports `Content-Length`; other remote media URLs are best-effort via yt-dlp.
- Operators who accept the disk/DoS tradeoff for larger remote podcast/media files can opt in with `SUMMARIZE_REMOTE_MEDIA_MAX_BYTES=<positive integer byte limit>`. The override must be a finite positive integer byte count; fractional, sub-byte, or otherwise invalid values are ignored and the default 512 MB cap remains in effect.
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
- Chrome Browser mode resolves captionless YouTube audio through same-origin Android VR media with captured SABR fallback, decodes it through WebAudio or MediaBunny/WebCodecs, and transcribes with browser-cached multilingual Whisper Tiny.

## Known limits

- No auth/cookie handling for embedded media; login-gated assets will fail.
- Captions are best-effort; if captions are missing or unreadable, we fall back to transcription.
