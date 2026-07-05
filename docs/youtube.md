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
- `yt-dlp`: download audio + transcribe (Groq first; then local ONNX/`whisper.cpp`; then AssemblyAI/Gemini/OpenAI/FAL/Deepgram fallback)

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
- `yt-dlp` requires the `yt-dlp` binary (either set `YT_DLP_PATH` or have it on `PATH`) and either local `whisper.cpp` or one of `GROQ_API_KEY`, `ASSEMBLYAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `FAL_KEY`, or `DEEPGRAM_API_KEY`.
  - Remote cloud fallback order after Groq/local providers is AssemblyAI, Gemini, OpenAI, FAL, then Deepgram.
  - Gemini handles larger uploads via the Files API and defaults to `gemini-2.5-flash`; override with `SUMMARIZE_GEMINI_TRANSCRIPTION_MODEL`.
  - Deepgram defaults to `nova-3`; override with `SUMMARIZE_DEEPGRAM_TRANSCRIPTION_MODEL`.

## Example

```bash
pnpm summarize -- --extract "https://www.youtube.com/watch?v=I845O57ZSy4&t=11s"
```

## Speaker labels

`--diarize [auto|elevenlabs|openai]` forces audio transcription so the output can identify speaker changes:

```bash
summarize "https://www.youtube.com/watch?v=..." --extract --diarize
summarize "https://www.youtube.com/watch?v=..." --extract --diarize openai --timestamps
```

- `auto`: ElevenLabs Scribe v2 first, then OpenAI `gpt-4o-transcribe-diarize`.
- `elevenlabs`: requires `ELEVENLABS_API_KEY`.
- `openai`: requires `OPENAI_API_KEY`.
- YouTube diarization requires `yt-dlp` and downloads audio only. With `--slides`, one yt-dlp invocation downloads separate audio-only and video-only streams so diarization uploads audio while slide extraction reuses video without a merge. Local media diarization does not require `yt-dlp`; local video audio is extracted with native or bundled FFmpeg before upload and reused across provider fallbacks. OpenAI uploads are compressed to stay under its size limit when possible, and long recordings are split into bounded chunks with offset timestamps and distinct chunk-local labels.

## Speaker identification

Diarization detects speaker changes but providers return generic labels. Add `--identify-speakers` to
resolve those labels to names:

```bash
summarize "https://www.youtube.com/watch?v=..." --extract \
  --diarize elevenlabs --identify-speakers \
  --speaker-profile modern-wisdom \
  --speaker-at "0:12=Chris Williamson" \
  --speaker-at "1:42=Guest Name" \
  --remember-speakers
```

Resolution order:

1. Repeatable `--speaker-at <timestamp=name>` anchors and source anchors from config.
2. Remembered provider-label mappings, but only when the full diarized transcript SHA-256 still matches.
3. OpenAI GPT-5.5 context inference using video metadata, profile context, known names, and representative transcript excerpts.

Only mappings at or above `minimumConfidence` are applied. Uncertain speakers keep their generic labels.
Anchors are authoritative. `--remember-speakers` atomically updates `~/.summarize/config.json` with the
selected profile, anchors, names, transcript hash, and mapping. Raw provider transcript cache entries stay
generic, so names from one run cannot contaminate another source.

Use `--no-identify-speakers` to disable configured identification for one run. ElevenLabs diarization needs
`ELEVENLABS_API_KEY`; GPT-5.5 identity inference for unresolved labels needs `OPENAI_API_KEY`.

See [Config](config.md#speaker-identification) for reusable profiles.

## Slides

Use `--slides` to extract slide screenshots for YouTube videos (`yt-dlp` required; native ffmpeg preferred, bundled WebAssembly fallback included).
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
