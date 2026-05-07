---
title: "Config"
kicker: "get started"
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

For output length:

1. CLI flag `--length`
2. Config file `output.length`
3. Built-in default (`xl`)

See `docs/language.md` for supported values.

For prompt:

1. CLI flag `--prompt` / `--prompt-file`
2. Config file `prompt`
3. Built-in default prompt

For environment variables:

1. Process environment variables
2. Config file `env`
3. Legacy config file `apiKeys` (mapped to env names)

For UI theme:

1. CLI flag `--theme`
2. Env `SUMMARIZE_THEME`
3. Config file `ui.theme`
4. Built-in default (`aurora`)

## Format

`~/.summarize/config.json`:

```json
{
  "model": { "id": "google/gemini-3-flash" },
  "env": { "OPENAI_API_KEY": "sk-..." },
  "output": { "language": "auto", "length": "long" },
  "prompt": "Explain like I am five.",
  "ui": { "theme": "ember" }
}
```

`output.length` accepts the same values as `--length`:

- Presets: `short`, `medium`, `long`, `xl`, `xxl`
- Shorthand: `s`, `m`, `l`
- Character targets: `1500`, `20k`, `20000`

Shorthand (equivalent):

```json
{
  "model": "google/gemini-3-flash"
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

## Environment defaults

Set any env var in config (process env still wins):

```json
{
  "env": {
    "ASSEMBLYAI_API_KEY": "...",
    "OPENAI_API_KEY": "sk-...",
    "OPENROUTER_API_KEY": "sk-or-...",
    "FIRECRAWL_API_KEY": "...",
    "CUSTOM_FLAG": "1"
  }
}
```

Legacy shortcut (still supported):

```json
{
  "apiKeys": {
    "openai": "sk-...",
    "groq": "gsk-...",
    "assemblyai": "...",
    "anthropic": "sk-ant-...",
    "google": "...",
    "openrouter": "sk-or-...",
    "xai": "...",
    "zai": "...",
    "apify": "...",
    "firecrawl": "...",
    "fal": "..."
  }
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
    "small": { "id": "openai/gpt-5-mini" },
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
- `gpt-fast` and `fast` remain compatibility aliases for OpenAI GPT-5.5 Fast mode. Prefer `model: "openai/gpt-5.5"` plus `openai.serviceTier` / `openai.thinking`. `codex-fast` is the explicit Codex CLI fast preset.

OpenAI request options can be set globally:

```json
{
  "openai": {
    "serviceTier": "fast",
    "thinking": "medium",
    "textVerbosity": "low"
  }
}
```

Or per preset:

```json
{
  "models": {
    "fast-mini": {
      "id": "openai/gpt-5.4-mini",
      "serviceTier": "fast",
      "thinking": "low"
    }
  }
}
```

`thinking` is an alias for `reasoningEffort`. Supported values: `none`, `low`, `medium`, `high`, `xhigh`; shorthand aliases include `off`, `min` (low), `mid`, `med`, `x-high`, and `extra-high`.

`serviceTier: "fast"` is the summarize/Codex-facing spelling. Direct OpenAI requests map it to `service_tier="priority"`. CLI `--service-tier default` clears a configured tier for one run.

Use a preset as your default `model`:

```json
{
  "model": "small"
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
    "enabled": ["gemini", "agent", "openclaw", "opencode", "copilot"],
    "autoFallback": {
      "enabled": true,
      "onlyWhenNoApiKeys": true,
      "order": ["claude", "gemini", "codex", "agent", "openclaw", "opencode", "copilot"]
    },
    "codex": { "model": "gpt-5.2" },
    "claude": { "binary": "/usr/local/bin/claude", "extraArgs": ["--verbose"] },
    "agent": { "binary": "/usr/local/bin/agent", "model": "gpt-5.2" },
    "openclaw": { "binary": "/usr/local/bin/openclaw", "model": "main" },
    "opencode": { "binary": "/usr/local/bin/opencode", "model": "openai/gpt-5.4" },
    "copilot": { "binary": "/usr/local/bin/copilot", "model": "gpt-5.2" }
  }
}
```

Notes:

- `cli.enabled` is an allowlist (and order) for auto + explicit CLI model ids.
- `cli.autoFallback` controls implicit-auto CLI fallback when `cli.enabled` is not set.
- Default auto fallback order: `claude, gemini, codex, agent, openclaw, opencode, copilot`.
- Auto fallback stores the last successful provider in `~/.summarize/cli-state.json` and prioritizes it on the next run.
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
  "nvidia": { "baseUrl": "https://integrate.api.nvidia.com/v1" },
  "anthropic": { "baseUrl": "https://my-anthropic-proxy.example.com" },
  "google": { "baseUrl": "https://my-google-proxy.example.com" },
  "xai": { "baseUrl": "https://my-xai-proxy.example.com" },
  "zai": { "baseUrl": "https://api.zhipuai.cn/paas/v4" }
}
```

Or via environment variables (which take precedence over config):

| Provider  | Environment Variable(s)                      |
| --------- | -------------------------------------------- |
| OpenAI    | `OPENAI_BASE_URL`                            |
| NVIDIA    | `NVIDIA_BASE_URL`                            |
| Anthropic | `ANTHROPIC_BASE_URL`                         |
| Google    | `GOOGLE_BASE_URL` (alias: `GEMINI_BASE_URL`) |
| xAI       | `XAI_BASE_URL`                               |
| Z.AI      | `Z_AI_BASE_URL` (alias: `ZAI_BASE_URL`)      |
