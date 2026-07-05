---
title: "Transcript flow"
kicker: "internals"
summary: "Map of transcript provider selection and transcription fallback flow."
read_when:
  - "When changing podcast, YouTube, or generic transcript provider order."
  - "When changing remote transcription fallbacks or provider setup errors."
---

# Transcript Provider Flow

Goal: keep provider entrypoints thin; keep provider policy explicit.

## Provider entrypoints

- `packages/core/src/content/transcript/providers/youtube.ts`
  YouTube orchestration only.
  Web captions first.
  `yt-dlp`, Android VR direct media, then Apify fallback.
- `packages/core/src/content/transcript/providers/youtube/native-media.ts`
  Android VR direct-audio resolution + shared media transcription only.
- `packages/core/src/content/transcript/providers/podcast.ts`
  Podcast orchestration only.
  Feed/Spotify/Apple/enclosure/`yt-dlp` chain.
- `packages/core/src/content/transcript/providers/generic.ts`
  Thin orchestration only.
  Embedded tracks first.
  Direct-media / X media fallback next.
- `packages/core/src/content/transcript/providers/generic-embedded.ts`
  Embedded media detection + caption-track parsing only.
- `packages/core/src/content/transcript/providers/generic-direct-media.ts`
  Direct-media yt-dlp/transcription fallback only.
- `packages/core/src/content/transcript/providers/generic-twitter.ts`
  X/Twitter cookies + yt-dlp orchestration only.

## Shared policy

- `transcription-capability.ts`
  One place for:
  - `resolveTranscriptProviderCapabilities`
  - `canTranscribe`
  - `canRunYtDlp`
  - missing-provider note/result shaping
- `transcription-start.ts`
  Runtime availability only.
  Local whisper, ONNX, cloud presence, display hints.

## Remote fallback

- `packages/core/src/transcription/whisper/cloud-providers.ts`
  Provider order + labels + model-id chain.
- `packages/core/src/transcription/whisper/remote-provider-attempts.ts`
  Per-provider byte/file attempts.
- `packages/core/src/transcription/whisper/remote.ts`
  Order loop only.
  Fallback notes.
  OpenAI chunk/delegate policy.
- `packages/core/src/transcription/whisper/diarization.ts`
  Explicit speaker-label requests only.
  Extracts local video audio once before provider attempts.
  ElevenLabs Scribe v2 first in auto mode, then OpenAI `gpt-4o-transcribe-diarize`.
- YouTube yt-dlp media:
  Diarization-only downloads audio.
  Combined slides + diarization downloads separate audio/video streams once and shares the video cache entry with slide extraction.
- `src/speaker-identification/`
  Optional post-processing for generic diarization labels.
  Timestamp anchors first, exact-transcript remembered mappings second, OpenAI GPT-5.5 context inference last.
  Named extracts have identity-aware cache keys; raw transcript cache entries remain provider-generic.

## Current order

- Groq first when `GROQ_API_KEY` is set
- local ONNX / whisper.cpp before the remaining cloud providers
- remaining cloud bytes/file order:
  - AssemblyAI
  - Gemini
  - OpenAI
  - FAL
  - Deepgram
- speaker diarization (`--diarize`):
  - ElevenLabs
  - OpenAI

## Rules

- keep entrypoints thin
- add provider notes in shared helpers, not scattered strings
- prefer pure parser helpers before touching orchestration
- if adding a new provider:
  - register cloud metadata
  - add remote attempt handler
  - widen shared capability helper
  - add focused provider tests before live tests
