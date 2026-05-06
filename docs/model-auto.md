---
title: "Auto selection"
kicker: "models"
summary: "Auto model selection logic and config rules."
read_when:
  - "When changing auto selection behavior."
---

# Auto model selection (`--model auto`)

`--model auto` picks a model based on input kind + token size, and retries with fallbacks when something fails.

This is also the built-in default when you don’t specify a model.

## What it does

- Builds an ordered list of model “attempts” from `candidates[]` (native first, optional OpenRouter fallback).
- Skips attempts that don’t have the required API key configured.
- On any request error, tries the next attempt.
- If no model is usable, prints the extracted text (no LLM summary). Use `--extract` if you want the raw extracted content even when models are available.
- Auto prepends CLI attempts when either:
  - `cli.enabled` is set (order follows `cli.enabled`), or
  - implicit auto selection is active and `cli.autoFallback` allows it.

## OpenRouter vs native

Model ids:

- Native: `<provider>/<model>` (e.g. `openai/gpt-5-mini`, `google/gemini-3-flash`)
- Forced OpenRouter: `openrouter/<author>/<slug>` (e.g. `openrouter/meta-llama/llama-3.3-70b-instruct:free`)

Behavior:

- If you pass an `openrouter/...` model id, the request uses OpenRouter (and requires `OPENROUTER_API_KEY`).
- If you pass a native model id, the CLI prefers the native provider SDK when its key is available, and can fall back to OpenRouter when no native key exists (and `OPENROUTER_API_KEY` is set).

## How selection works

- Uses the order you provide in `model.rules[].candidates[]` (or `bands[].candidates[]`).
- Filters out candidates that can’t fit the prompt (max input tokens, LiteLLM catalog).
- For a native candidate, auto mode may add an OpenRouter fallback attempt right after it (when `OPENROUTER_API_KEY` is set, video understanding isn’t required, and a matching OpenRouter model id is found). If no unique OpenRouter id matches, the fallback is skipped.
- To force native-only attempts, unset `OPENROUTER_API_KEY` (or pass an explicit native model id like `xai/...` and keep the key unset).

Notes:

- Auto mode is non-streaming (so a failed attempt won’t partially print output).
- Video understanding is only attempted when `--video-mode` is `auto` or `understand`, and a video-capable model is selected.

## Config

Default config file: `~/.summarize/config.json`

This file is parsed leniently (JSON5), but **comments are not allowed**.

`model.rules` is optional; when omitted, built-in defaults apply.

`model.rules[].when` is optional, and when present must be an array (e.g. `["video","youtube"]`).

Rules can be either:

- `candidates: string[]`
- `bands: [{ token?: { min?: number; max?: number }, candidates: string[] }]`

Example:

```json
{
  "model": {
    "mode": "auto",
    "rules": [
      {
        "when": ["video"],
        "candidates": ["google/gemini-3-flash"]
      },
      {
        "when": ["website", "youtube"],
        "bands": [
          {
            "token": { "max": 8000 },
            "candidates": ["openai/gpt-5-mini"]
          },
          {
            "candidates": ["xai/grok-4-fast-non-reasoning"]
          }
        ]
      },
      {
        "candidates": ["openai/gpt-5-mini", "openrouter/openai/gpt-5-mini"]
      }
    ]
  },
  "media": { "videoMode": "auto" }
}
```

Minimal shorthand:

```json
{
  "model": "auto"
}
```
