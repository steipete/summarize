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
2. yt-dlp download + transcription (Groq first; then ONNX/local whisper.cpp; then AssemblyAI/Gemini/OpenAI/FAL/Deepgram fallback).
3. YouTube only: Android VR direct audio + the same transcription chain when yt-dlp is missing or fails.

## CLI behavior

- `--video-mode transcript` prefers transcript-first media handling even when a page has text.
- Direct media URLs (mp4/webm/m4a/etc) skip HTML and transcribe.
- Local audio/video files are routed through the same transcript-first pipeline.
- `--diarize [auto|elevenlabs|openai]` adds speaker labels to local files and direct media URLs; `--identify-speakers`, anchors, profiles, and remembered mappings use the same naming pass as YouTube. Local files do not require `yt-dlp`. Local video is converted once to mono 16 kHz MP3 before upload, then reused if diarization falls back between providers.
- YouTube diarization selects audio-only media. Combined `--slides --diarize` downloads separate video-only and audio-only streams in one yt-dlp run, then shares the video with slide extraction.
- YouTube still uses the YouTube transcript pipeline (captions → yt-dlp → Android VR direct audio fallback).
- X/Twitter status URLs with detected video auto-switch to transcript-first (yt-dlp), even in auto mode.
- X broadcasts (`/i/broadcasts/...`) are treated as media-only and go transcript-first by default.
- Local media files are capped at 2 GB. Remote podcast/media transcription downloads are capped at 512 MB by default and fail closed with `Remote media too large` even when the server omits or under-reports `Content-Length`; other remote media URLs are best-effort via yt-dlp.
- Operators who accept the disk/DoS tradeoff for larger remote podcast/media files can opt in with `SUMMARIZE_REMOTE_MEDIA_MAX_BYTES=<positive integer byte limit>`. The override must be a finite positive integer byte count; fractional, sub-byte, or otherwise invalid values are ignored and the default 512 MB cap remains in effect.
- Remote transcription providers: `ASSEMBLYAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `FAL_KEY`, `DEEPGRAM_API_KEY` (plus `GROQ_API_KEY` before local/remote fallback). Gemini defaults to `gemini-2.5-flash`; override with `SUMMARIZE_GEMINI_TRANSCRIPTION_MODEL`. Deepgram defaults to `nova-3`; override with `SUMMARIZE_DEEPGRAM_TRANSCRIPTION_MODEL`. Diarization uses `ELEVENLABS_API_KEY` or `OPENAI_API_KEY`.
- Gemini uses the Files API automatically for larger uploads.

## Shared helpers

- Direct media classification lives in `packages/core/src/content/direct-media.ts`.
- Local path/`file://` normalization + mtime lookup lives in `packages/core/src/content/local-file.ts`.
- Slides, URL extraction, and transcription should reuse those helpers instead of re-parsing extensions separately.

## Chrome extension behavior

- When media is detected on a page, the Summarize button gains a dropdown caret (Page/Video or Page/Audio).
- Selecting Video/Audio forces URL mode + transcript-first extraction for that run only.
- Selection is not stored.
- Chrome Browser mode transcribes fetchable direct and embedded media in bounded MediaBunny/WebCodecs chunks with browser-cached multilingual Whisper Tiny. YouTube prefers active-player/watch-page direct audio, then Android VR, buffered direct audio, and captured SABR.
- Browser slide extraction uses ranged MediaBunny URL reads instead of buffering the complete video. The Whisper runtime is disposed after an idle period while the downloaded model remains in browser cache.

## Known limits

- No auth/cookie handling for embedded media; login-gated assets will fail.
- Captions are best-effort; if captions are missing or unreadable, we fall back to transcription.
