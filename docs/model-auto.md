# Auto model selection (design)

Goal: `--model auto` picks “best” model for the input, with simple fallbacks, without over-engineering.

This doc describes the intended behavior + config shape. (Feature may not be released yet.)

## Concepts

### Transport vs model id

We need to distinguish **where** the request goes (transport) from **what** we ask for (model id).

- Native (preferred): `openai/...`, `google/...`, `xai/...`, `anthropic/...` use provider SDKs directly.
- OpenRouter (forced): `openrouter/...` routes via OpenRouter’s OpenAI-compatible API.

So these are intentionally different:

- `xai/grok-4-fast-non-reasoning` (native xAI SDK)
- `openrouter/xai/grok-4-fast-non-reasoning` (OpenRouter transport)

### Candidate

An auto “candidate” is a model + transport + optional provider hints (OpenRouter provider order), plus scoring hints.

Auto selection:

- Skips candidates immediately if required key is missing.
- Tries candidates in score order.
- On any request error, tries the next candidate.

## Video handling

New flag:

- `--video-mode auto|transcript|understand`

Behavior:

- `auto`: prefer **video understanding** when the chosen model supports it; otherwise transcript.
- `transcript`: YouTube transcript if possible; else (future) audio transcription path.
- `understand`: force Gemini video understanding (native `google/...`), even if transcript exists.

Websites:

- Default: extract text and summarize.
- If page is “basically only a video”, switch to video handling.
  - Detection signals (cheap): `og:video*`, `twitter:player`, `<video>` tags, JSON-LD `VideoObject`, YouTube/Vimeo embeds.
  - If we can resolve a playable asset URL (e.g. `.mp4/.webm`) or a YouTube video id, run the video pipeline.

## “No model needed”

If extracted text is shorter than what we’d ask the model to produce:

- If `extractedTextTokens <= requestedOutputTokens` → return extracted text directly.

No footer needed in this case unless we used a special extractor (Firecrawl/markitdown/transcription).

## Output footer (“what happened”)

At the end, print one concise line when we did non-trivial work:

- extractor used (e.g. `via firecrawl`, `preprocess markitdown(pdf)`, `youtube transcript (web)`).
- model + transport (e.g. `model google/gemini-3-flash (native)`, `model xai/grok-4-fast-non-reasoning (openrouter)`).

Skip the footer when the output is just the extracted text and no special extractor ran.

## Config shape (in `~/.summarize/config.json`)

No comments; JSON only.

Suggested additions:

```json
{
  "model": "auto",
  "auto": {
    "rules": [
      {
        "when": { "kind": "video" },
        "candidates": [
          { "model": "google/gemini-3-flash", "score": { "quality": 9, "cost": 4 } },
          { "model": "openrouter/google/gemini-3-flash", "score": { "quality": 8, "cost": 5 } }
        ]
      },
      {
        "when": { "kind": "text" },
        "candidates": [
          { "model": "openai/gpt-5-nano", "score": { "quality": 7, "cost": 9 } },
          { "model": "xai/grok-4-fast-non-reasoning", "score": { "quality": 7, "cost": 8 } }
        ]
      }
    ]
  },
  "media": {
    "videoMode": "auto"
  }
}
```

Notes:

- `model: "auto"` is just a convenience default; `--model auto` should override.
- `when.kind` is a coarse input classifier: `text|website|youtube|image|video|file`.
- Scores are relative hints; runtime filters still apply (key present, context fits, attachment supported).

