---
summary: "Config file location, precedence, and schema."
read_when:
  - "When adding config keys or defaults."
---

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

For output language:

1. CLI flag `--language` / `--lang`
2. Config file `output.language` (preferred) or `language` (legacy)
3. Built-in default (`auto` = match source content language)

See `docs/language.md` for supported values.

For prompt:

1. CLI flag `--prompt` / `--prompt-file`
2. Config file `prompt`
3. Built-in default prompt

For UI theme:

1. CLI flag `--theme`
2. Env `SUMMARIZE_THEME`
3. Config file `ui.theme`
4. Built-in default (`aurora`)
## Format

`~/.summarize/config.json`:

```json
{
  "model": { "id": "google/gemini-3-flash-preview" },
  "output": { "language": "auto" },
  "prompt": "Explain like I am five.",
  "ui": { "theme": "ember" }
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

## Prompt

`prompt` replaces the built-in summary instructions (same behavior as `--prompt`).

Example:

```json
{
  "prompt": "Explain for a kid. Short sentences. Simple words."
}
```

## Cache

Configure the on-disk SQLite cache (extracted content, transcripts, summaries).

```json
{
  "cache": {
    "enabled": true,
    "maxMb": 512,
    "ttlDays": 30,
    "path": "~/.summarize/cache.sqlite",
    "media": {
      "enabled": true,
      "maxMb": 2048,
      "ttlDays": 7,
      "path": "~/.summarize/cache/media",
      "verify": "size"
    }
  }
}
```

Notes:

- `cache.media` controls the **media file** cache (yt-dlp downloads).
- `--no-cache` bypasses summary caching only (LLM output); extract/transcript caches still apply. Use `--no-media-cache` for media.
- `verify`: `size` (default), `hash`, or `none`.

## UI theme

Set a default CLI theme:

```json
{
  "ui": { "theme": "moss" }
}
```

## Slides defaults

Enable slides by default and tune extraction parameters:

```json
{
  "slides": {
    "enabled": true,
    "ocr": false,
    "dir": "slides",
    "sceneThreshold": 0.3,
    "max": 20,
    "minDuration": 2
  }
}
```

## Logging (daemon)

Enable JSON log files for the daemon:

```json
{
  "logging": {
    "enabled": true,
    "level": "info",
    "format": "json",
    "file": "~/.summarize/logs/daemon.jsonl",
    "maxMb": 10,
    "maxFiles": 3
  }
}
```

Notes:

- Default: logging is off.
- `format`: `json` (default) or `pretty`.
- `maxMb` is per file; `maxFiles` controls rotation (ring).
- Extension “Extended logging” sends full input/output to daemon logs (large). Cache hits skip content logging.

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

## Output language

Set a default output language for summaries:

```json
{
  "output": { "language": "auto" }
}
```

Examples:

- `"auto"` (default): match the source language.
- `"en"`, `"de"`: common shorthands.
- `"english"`, `"german"`: common names.
- `"en-US"`, `"pt-BR"`: BCP-47-ish tags.

## CLI config

```json
{
  "cli": {
    "enabled": ["gemini", "agent"],
    "codex": { "model": "gpt-5.2" },
    "claude": { "binary": "/usr/local/bin/claude", "extraArgs": ["--verbose"] },
    "agent": { "binary": "/usr/local/bin/agent", "model": "gpt-5.2" }
  }
}
```

Notes:

- `cli.enabled` is an allowlist (auto uses CLIs only when set; explicit `--cli` / `--model cli/...` must be included).
- Recommendation: keep `cli.enabled` to `["gemini"]` or `["agent"]` unless you have a reason to add others (extra latency/variance).
- `cli.<provider>.binary` overrides CLI binary discovery.
- `cli.<provider>.extraArgs` appends extra CLI args.

## OpenAI config

```json
{
  "openai": {
    "baseUrl": "https://my-openai-proxy.example.com/v1",
    "useChatCompletions": true,
    "whisperUsdPerMinute": 0.006
  }
}
```

Notes:

- `openai.baseUrl` overrides the OpenAI-compatible API endpoint. Use this for proxies, gateways, or OpenAI-compatible APIs. Env `OPENAI_BASE_URL` takes precedence.
- `openai.whisperUsdPerMinute` is only used to estimate transcription cost in the finish-line metrics when Whisper transcription runs via OpenAI.

## Provider base URLs

Override API endpoints for any provider to use proxies, gateways, or compatible APIs:

```json
{
  "openai": { "baseUrl": "https://my-openai-proxy.example.com/v1" },
  "anthropic": { "baseUrl": "https://my-anthropic-proxy.example.com" },
  "google": { "baseUrl": "https://my-google-proxy.example.com" },
  "xai": { "baseUrl": "https://my-xai-proxy.example.com" }
}
```

Or via environment variables (which take precedence over config):

| Provider   | Environment Variable(s)                |
| ---------- | -------------------------------------- |
| OpenAI     | `OPENAI_BASE_URL`                      |
| Anthropic  | `ANTHROPIC_BASE_URL`                   |
| Google     | `GOOGLE_BASE_URL` (alias: `GEMINI_BASE_URL`) |
| xAI        | `XAI_BASE_URL`                         |
