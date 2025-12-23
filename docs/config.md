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
4. Built-in default (`auto`)

## Format

`~/.summarize/config.json`:

```json
{
  "model": { "id": "google/gemini-3-flash-preview" }
}
```

Shorthand (equivalent):

```json
{
  "model": "google/gemini-3-flash-preview"
}
```

`model` can also be auto:

```json
{
  "model": { "mode": "auto" }
}
```

Shorthand (equivalent):

```json
{
  "model": "auto"
}
```

## Presets

Define presets you can select via `--model <preset>`:

```json
{
  "models": {
    "fast": { "id": "openai/gpt-5-mini" },
    "or-free": {
      "rules": [
        {
          "candidates": [
            "openrouter/google/gemini-2.0-flash-exp:free",
            "openrouter/meta-llama/llama-3.3-70b-instruct:free"
          ]
        }
      ]
    }
  }
}
```

Notes:

- `auto` is reserved and can’t be defined as a preset.
- `free` is built-in (OpenRouter `:free` candidates). Override it by defining `models.free` in your config, or regenerate it via `summarize refresh-free`.

Use a preset as your default `model`:

```json
{
  "model": "fast"
}
```

Notes:

- For presets, `"mode": "auto"` is optional when `"rules"` is present.

For auto selection with rules:

```json
{
  "model": {
    "mode": "auto",
    "rules": [
      {
        "when": ["video"],
        "candidates": ["google/gemini-3-flash-preview"]
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

Notes:

- Parsed leniently (JSON5), but **comments are not allowed**.
- Unknown keys are ignored.
- `model.rules` is optional. If omitted, built-in defaults apply.
- `model.rules[].when` (optional) must be an array (e.g. `["video","youtube"]`).
- `model.rules[]` must use either `candidates` or `bands`.

## CLI config

```json
{
  "cli": {
    "enabled": ["gemini"],
    "codex": { "model": "gpt-5.2" },
    "claude": { "binary": "/usr/local/bin/claude", "extraArgs": ["--verbose"] }
  }
}
```

Notes:

- `cli.enabled` is an allowlist (auto uses CLIs only when set; explicit `--cli` / `--model cli/...` must be included).
- Recommendation: keep `cli.enabled` to `["gemini"]` unless you have a reason to add others (extra latency/variance).
- `cli.<provider>.binary` overrides CLI binary discovery.
- `cli.<provider>.extraArgs` appends extra CLI args.
