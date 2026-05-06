---
title: "YouTube"
kicker: "modes"
summary: "YouTube transcript extraction modes and fallbacks."
read_when:
  - "When changing YouTube handling."
---

# YouTube mode

YouTube URLs use transcript-first extraction.

## `--youtube auto|web|no-auto|apify|yt-dlp`

- `auto` (default): try `youtubei` → `captionTracks` → `yt-dlp` (if configured) → Apify (if token exists)
- `web`: try `youtubei` → `captionTracks` only
- `no-auto`: try creator captions only (skip auto-generated/ASR) → `yt-dlp` (if configured)
- `apify`: Apify only
- `yt-dlp`: download audio + transcribe (Groq first; then local `whisper.cpp`; then AssemblyAI/Gemini/OpenAI/FAL fallback)

## `youtubei` vs `captionTracks`

- `youtubei`:
  - Calls YouTube’s internal transcript endpoint (`/youtubei/v1/get_transcript`).
  - Needs a bootstrapped `INNERTUBE_API_KEY`, context, and `getTranscriptEndpoint.params` from the watch page HTML.
  - When it works, you get a nice list of transcript segments.
- `captionTracks`:
  - Downloads caption tracks listed in `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks`.
  - Fetches `fmt=json3` first and falls back to XML-like caption payloads if needed.
  - Often works even when the transcript endpoint doesn’t.

## Fallbacks

- If no transcript is available, we still extract `ytInitialPlayerResponse.videoDetails.shortDescription` so YouTube links can still summarize meaningfully.
- Apify is an optional fallback (needs `APIFY_API_TOKEN`).
  - By default, we use the actor id `faVsWy9VTSNVIhWpR` (Pinto Studio’s “Youtube Transcript Scraper”).
- `yt-dlp` requires the `yt-dlp` binary (either set `YT_DLP_PATH` or have it on `PATH`) and either local `whisper.cpp` or one of `GROQ_API_KEY`, `ASSEMBLYAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `FAL_KEY`.
  - AssemblyAI is supported as a dedicated remote transcription provider in the fallback chain.
  - Gemini is used automatically when available after AssemblyAI/local providers, and handles larger uploads via the Files API.
  - If OpenAI transcription fails and `FAL_KEY` is set, we fall back to FAL automatically.

## Example

```bash
pnpm summarize -- --extract "https://www.youtube.com/watch?v=I845O57ZSy4&t=11s"
```

## Slides

Use `--slides` to extract slide screenshots for YouTube videos (requires `ffmpeg` and `yt-dlp`).
Scene detection auto-tunes the threshold using sampled frame hashes:

```bash
summarize "https://www.youtube.com/watch?v=..." --slides
summarize "https://www.youtube.com/watch?v=..." --slides --slides-ocr
```

Slides are written to `./slides/<videoId>/` by default (override with `--slides-dir`). OCR results
are stored in `slides.json` and included in JSON output (`--json`).

If yt-dlp gets a 403 from YouTube, set `SUMMARIZE_YT_DLP_COOKIES_FROM_BROWSER=chrome` (or
`chrome:Profile 1`) to pass cookies through to yt-dlp.

Relevant flags:

- `--slides-scene-threshold <value>`: starting threshold for scene detection (auto-tuned as needed)
