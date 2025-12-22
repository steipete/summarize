# Config

`summarize` supports an optional JSON config file for defaults.

## Location

Default path:

- `~/.summarize/config.json`

## Precedence

For `model`:

1. CLI flag `--model`
2. Env `SUMMARIZE_MODEL`
3. Config file `model`
4. Built-in default (`google/gemini-3-flash-preview`)

## Format

`~/.summarize/config.json`:

```json
{
  "model": "google/gemini-3-flash-preview"
}
```

`model` can also be:

- `"auto"` (automatic model selection; see `docs/model-auto.md`)
- `openrouter/<provider>/<model>` (force OpenRouter; requires `OPENROUTER_API_KEY`)

Additional keys (optional):

```json
{
  "model": "auto",
  "media": { "videoMode": "auto" },
  "auto": [
    {
      "when": "video",
      "candidates": ["google/gemini-3-flash-preview"]
    },
    {
      "when": { "kind": ["website", "youtube"] },
      "candidates": ["openai/gpt-5-nano", "xai/grok-4-fast-non-reasoning"]
    },
    {
      "candidates": ["openai/gpt-5-nano", "openrouter/openai/gpt-5-nano"]
    }
  ]
}
```

Notes:

- Parsed leniently (JSON5), but **comments are not allowed**.
